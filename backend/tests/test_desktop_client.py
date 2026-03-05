"""
Tests for lambdas/desktop_client.py — Tailscale Funnel SSM integration.

Covers:
  - SSM URL resolution and caching
  - Port normalization
  - Health check (desktop alive/offline)
  - OpenAI client construction
"""
from __future__ import annotations

import os
import sys
import time
from unittest.mock import MagicMock, patch

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "lambdas"))

# We need to import after setting up env mocks
import importlib


def _reload_module():
    """Reload desktop_client to reset module-level cache."""
    import desktop_client
    desktop_client._cached_base_url = None
    desktop_client._cache_time = 0.0
    return desktop_client


class TestGetDesktopBaseUrl:
    def test_reads_from_ssm(self):
        mod = _reload_module()
        mock_ssm = MagicMock()
        mock_ssm.get_parameter.side_effect = [
            {"Parameter": {"Value": "https://seratonin.tail40ae2c.ts.net"}},
            {"Parameter": {"Value": "443"}},
        ]
        mod._ssm = mock_ssm
        url = mod.get_desktop_base_url()
        assert url == "https://seratonin.tail40ae2c.ts.net:443"
        assert mock_ssm.get_parameter.call_count == 2

    def test_url_with_existing_port_not_doubled(self):
        mod = _reload_module()
        mock_ssm = MagicMock()
        mock_ssm.get_parameter.side_effect = [
            {"Parameter": {"Value": "https://seratonin.example.com:8080"}},
            {"Parameter": {"Value": "443"}},
        ]
        mod._ssm = mock_ssm
        url = mod.get_desktop_base_url()
        # URL already has a port, so it should NOT append another
        assert url == "https://seratonin.example.com:8080"

    def test_strips_trailing_slash(self):
        mod = _reload_module()
        mock_ssm = MagicMock()
        mock_ssm.get_parameter.side_effect = [
            {"Parameter": {"Value": "https://seratonin.example.com/"}},
            {"Parameter": {"Value": "1234"}},
        ]
        mod._ssm = mock_ssm
        url = mod.get_desktop_base_url()
        assert not url.endswith("/")
        assert ":1234" in url

    def test_cache_returns_previous_value(self):
        mod = _reload_module()
        mock_ssm = MagicMock()
        mock_ssm.get_parameter.side_effect = [
            {"Parameter": {"Value": "https://host1.example.com"}},
            {"Parameter": {"Value": "443"}},
        ]
        mod._ssm = mock_ssm
        url1 = mod.get_desktop_base_url()
        # Second call should use cache, not SSM
        url2 = mod.get_desktop_base_url()
        assert url1 == url2
        assert mock_ssm.get_parameter.call_count == 2  # Only first call

    def test_cache_expires(self):
        mod = _reload_module()
        mock_ssm = MagicMock()
        mock_ssm.get_parameter.side_effect = [
            {"Parameter": {"Value": "https://host1.example.com"}},
            {"Parameter": {"Value": "443"}},
            {"Parameter": {"Value": "https://host2.example.com"}},
            {"Parameter": {"Value": "443"}},
        ]
        mod._ssm = mock_ssm
        mod._CACHE_TTL_S = 0.01  # Very short TTL
        url1 = mod.get_desktop_base_url()
        time.sleep(0.02)
        url2 = mod.get_desktop_base_url()
        assert "host1" in url1
        assert "host2" in url2

    def test_ssm_failure_raises_runtime_error(self):
        mod = _reload_module()
        mock_ssm = MagicMock()
        mock_ssm.get_parameter.side_effect = Exception("SSM unreachable")
        mod._ssm = mock_ssm
        with pytest.raises(RuntimeError, match="Desktop SSM params not configured"):
            mod.get_desktop_base_url()


class TestIsDesktopAlive:
    def test_alive_returns_true(self):
        mod = _reload_module()
        mod._cached_base_url = "https://seratonin.example.com:443"
        mod._cache_time = time.time()
        with patch("desktop_client.urllib.request.urlopen") as mock_urlopen:
            mock_resp = MagicMock()
            mock_resp.status = 200
            mock_resp.__enter__ = MagicMock(return_value=mock_resp)
            mock_resp.__exit__ = MagicMock(return_value=False)
            mock_urlopen.return_value = mock_resp
            assert mod.is_desktop_alive() is True

    def test_offline_returns_false(self):
        mod = _reload_module()
        mod._cached_base_url = "https://seratonin.example.com:443"
        mod._cache_time = time.time()
        with patch("desktop_client.urllib.request.urlopen", side_effect=Exception("timeout")):
            assert mod.is_desktop_alive() is False

    def test_ssm_failure_returns_false(self):
        mod = _reload_module()
        mock_ssm = MagicMock()
        mock_ssm.get_parameter.side_effect = Exception("SSM error")
        mod._ssm = mock_ssm
        assert mod.is_desktop_alive() is False


class TestGetOpenaiClient:
    def test_returns_client_and_model(self):
        mod = _reload_module()
        mod._cached_base_url = "https://seratonin.example.com:443"
        mod._cache_time = time.time()
        with patch("desktop_client.OpenAI") as MockOpenAI:
            mock_instance = MagicMock()
            MockOpenAI.return_value = mock_instance
            client, model_name = mod.get_openai_client(timeout=30.0)
        assert client == mock_instance
        assert isinstance(model_name, str)
        MockOpenAI.assert_called_once()
        call_kwargs = MockOpenAI.call_args
        assert "lm-studio" in str(call_kwargs)

    def test_custom_timeout(self):
        mod = _reload_module()
        mod._cached_base_url = "https://seratonin.example.com:443"
        mod._cache_time = time.time()
        with patch("desktop_client.OpenAI") as MockOpenAI:
            MockOpenAI.return_value = MagicMock()
            mod.get_openai_client(timeout=580.0)
        assert MockOpenAI.call_args.kwargs["timeout"] == 580.0
