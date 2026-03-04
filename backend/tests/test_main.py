from types import SimpleNamespace
import io
import pathlib
import runpy
import sys

import pytest
from fastapi.testclient import TestClient
from PIL import Image

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
import main


def _make_png_bytes() -> bytes:
    img = Image.new('RGB', (12, 12), color='red')
    buf = io.BytesIO()
    img.save(buf, format='PNG')
    return buf.getvalue()


def _fake_response(content: str, reasoning: str = 'step by step'):
    class FakeMessage:
        def __init__(self, text: str, reasoning_text: str):
            self.content = text
            self._reasoning = reasoning_text

        def model_dump(self):
            return {'reasoning_content': self._reasoning}

    message = FakeMessage(content, reasoning)
    choice = SimpleNamespace(message=message, finish_reason='stop')
    return SimpleNamespace(choices=[choice])


def _patch_fake_openai(monkeypatch, content: str):
    fake_client = SimpleNamespace(
        models=SimpleNamespace(list=lambda: SimpleNamespace(data=[SimpleNamespace(id='fake-model')])),
        chat=SimpleNamespace(
            completions=SimpleNamespace(create=lambda **_: _fake_response(content))
        ),
    )
    monkeypatch.setattr(main, 'client', fake_client)


def test_parse_model_response_json():
    raw = '{"summary":"ok","key_observations":[],"content_classification":"photograph","extracted_text":"No text detected."}'
    parsed = main.parse_model_response(raw)
    assert parsed['summary'] == 'ok'
    assert parsed['content_classification'] == 'photograph'


def test_parse_model_response_markdown_fence():
    raw = '```json\n{"summary":"ok","key_observations":[],"content_classification":"other","extracted_text":"No text detected."}\n```'
    parsed = main.parse_model_response(raw)
    assert parsed['summary'] == 'ok'


def test_parse_model_response_non_json_fallback():
    parsed = main.parse_model_response('plain text not json')
    assert parsed['content_classification'] == 'unknown'
    assert parsed['summary'].startswith('plain text')


def test_extract_observations_from_reasoning():
    reasoning = '\n'.join([
        'Thinking...',
        '- I see a red square centered in the image with no text present.',
        '2) There is a flat color background and simple composition.',
    ])
    obs = main.extract_observations_from_reasoning(reasoning)
    assert len(obs) >= 1


def test_image_to_base64_data_url_and_convert_to_png_bytes():
    png = _make_png_bytes()
    data_url = main.image_to_base64_data_url(png, 'image/png')
    assert data_url.startswith('data:image/png/png;base64,')

    rgba = Image.new('RGBA', (4, 4), color=(255, 0, 0, 128))
    buf = io.BytesIO()
    rgba.save(buf, format='PNG')
    out = main.convert_to_png_bytes(buf.getvalue())
    assert out[:8] == b'\x89PNG\r\n\x1a\n'


def test_get_model_name_fallback_default(monkeypatch):
    fake_client = SimpleNamespace(models=SimpleNamespace(list=lambda: (_ for _ in ()).throw(RuntimeError('no model'))))
    monkeypatch.setattr(main, 'client', fake_client)
    monkeypatch.setattr(main, 'LM_STUDIO_MODEL', '')
    assert main.get_model_name() == 'default'


def test_get_model_name_empty_models(monkeypatch):
    fake_client = SimpleNamespace(models=SimpleNamespace(list=lambda: SimpleNamespace(data=[])))
    monkeypatch.setattr(main, 'client', fake_client)
    monkeypatch.setattr(main, 'LM_STUDIO_MODEL', '')
    assert main.get_model_name() == 'default'


def test_pdf_to_images_conversion_error(monkeypatch):
    def bad_convert(*_args, **_kwargs):
        raise RuntimeError('pdf error')

    monkeypatch.setattr('pdf2image.convert_from_bytes', bad_convert)

    with pytest.raises(main.HTTPException) as exc:
        main.pdf_to_images(b'%PDF-1.4')
    assert exc.value.status_code == 500


def test_pdf_to_images_success(monkeypatch):
    images = [Image.new('RGB', (3, 3), color='blue')]
    monkeypatch.setattr('pdf2image.convert_from_bytes', lambda *_args, **_kwargs: images)
    result = main.pdf_to_images(b'%PDF-1.4')
    assert isinstance(result, list)
    assert len(result) == 1
    assert result[0][:8] == b'\x89PNG\r\n\x1a\n'


def test_health_endpoint():
    client = TestClient(main.app)
    res = client.get('/api/health')
    assert res.status_code == 200
    data = res.json()
    assert data['status'] == 'ok'
    assert 'lm_studio_url' in data


def test_health_endpoint_when_models_unavailable(monkeypatch):
    fake_client = SimpleNamespace(models=SimpleNamespace(list=lambda: (_ for _ in ()).throw(RuntimeError('down'))))
    monkeypatch.setattr(main, 'client', fake_client)

    client = TestClient(main.app)
    res = client.get('/api/health')
    assert res.status_code == 200
    body = res.json()
    assert body['model_loaded'] is False


@pytest.mark.e2e
def test_analyze_endpoint_image_success(monkeypatch):
    content = '{"summary":"A red square.","key_observations":["Red block"],"content_classification":"photograph","extracted_text":"No text detected."}'
    _patch_fake_openai(monkeypatch, content)

    client = TestClient(main.app)
    image_bytes = _make_png_bytes()
    files = {'file': ('sample.png', image_bytes, 'image/png')}
    data = {'mode': 'fast', 'lang': 'en'}

    res = client.post('/api/analyze', files=files, data=data)
    assert res.status_code == 200

    body = res.json()
    assert body['summary'] == 'A red square.'
    assert body['mode'] == 'fast'
    assert body['model'] in {'fake-model', main.LM_STUDIO_MODEL}


@pytest.mark.e2e
def test_analyze_uses_reasoning_fallback_when_content_empty(monkeypatch):
    _patch_fake_openai(monkeypatch, content='')

    client = TestClient(main.app)
    image_bytes = _make_png_bytes()
    files = {'file': ('sample.png', image_bytes, 'image/png')}

    res = client.post('/api/analyze', files=files, data={'mode': 'fast', 'lang': 'en'})
    assert res.status_code == 200
    body = res.json()
    assert body['content_classification'].startswith('unknown')
    assert isinstance(body['key_observations'], list)


@pytest.mark.e2e
def test_analyze_returns_502_on_inference_error(monkeypatch):
    fake_client = SimpleNamespace(
        models=SimpleNamespace(list=lambda: SimpleNamespace(data=[SimpleNamespace(id='fake-model')])),
        chat=SimpleNamespace(
            completions=SimpleNamespace(create=lambda **_: (_ for _ in ()).throw(RuntimeError('inference failed')))
        ),
    )
    monkeypatch.setattr(main, 'client', fake_client)

    client = TestClient(main.app)
    image_bytes = _make_png_bytes()
    files = {'file': ('sample.png', image_bytes, 'image/png')}

    res = client.post('/api/analyze', files=files, data={'mode': 'fast', 'lang': 'en'})
    assert res.status_code == 502
    assert 'Model inference failed' in res.json()['detail']


@pytest.mark.e2e
def test_analyze_fails_when_file_exceeds_limit(monkeypatch):
    _patch_fake_openai(monkeypatch, '{"summary":"ok","key_observations":[],"content_classification":"other","extracted_text":"No text detected."}')
    monkeypatch.setattr(main, 'MAX_FILE_SIZE', 1)

    client = TestClient(main.app)
    files = {'file': ('sample.png', b'12345', 'image/png')}
    res = client.post('/api/analyze', files=files, data={'mode': 'fast', 'lang': 'en'})
    assert res.status_code == 400
    assert 'File exceeds' in res.json()['detail']


@pytest.mark.e2e
def test_analyze_pdf_path(monkeypatch):
    _patch_fake_openai(monkeypatch, '{"summary":"pdf","key_observations":[],"content_classification":"form/document","extracted_text":"No text detected."}')
    monkeypatch.setattr(main, 'pdf_to_images', lambda _bytes: [_make_png_bytes(), _make_png_bytes()])

    client = TestClient(main.app)
    files = {'file': ('sample.pdf', b'%PDF-1.4 fake', 'application/pdf')}
    res = client.post('/api/analyze', files=files, data={'mode': 'slow', 'lang': 'hi'})
    assert res.status_code == 200
    assert res.json()['summary'] == 'pdf'


@pytest.mark.e2e
def test_analyze_falls_back_to_original_when_png_conversion_fails(monkeypatch):
    _patch_fake_openai(monkeypatch, '{"summary":"img","key_observations":[],"content_classification":"photograph","extracted_text":"No text detected."}')
    monkeypatch.setattr(main, 'convert_to_png_bytes', lambda *_args, **_kwargs: (_ for _ in ()).throw(RuntimeError('bad image')))

    client = TestClient(main.app)
    image_bytes = _make_png_bytes()
    files = {'file': ('sample.png', image_bytes, 'image/png')}
    res = client.post('/api/analyze', files=files, data={'mode': 'fast', 'lang': 'en'})
    assert res.status_code == 200
    assert res.json()['summary'] == 'img'


def test_module_main_entrypoint(monkeypatch):
    calls: list[dict] = []

    fake_uvicorn = SimpleNamespace(run=lambda *args, **kwargs: calls.append({'args': args, 'kwargs': kwargs}))
    monkeypatch.setitem(sys.modules, 'uvicorn', fake_uvicorn)
    monkeypatch.setenv('PORT', '8765')

    runpy.run_module('main', run_name='__main__')

    assert calls
    assert calls[0]['kwargs']['port'] == 8765


@pytest.mark.e2e
def test_analyze_rejects_unsupported_type():
    client = TestClient(main.app)
    files = {'file': ('notes.txt', b'hello', 'text/plain')}
    data = {'mode': 'fast', 'lang': 'en'}

    res = client.post('/api/analyze', files=files, data=data)
    assert res.status_code == 400
    assert 'Unsupported file type' in res.json()['detail']
