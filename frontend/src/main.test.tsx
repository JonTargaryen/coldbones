import { describe, expect, it, vi } from 'vitest';

const renderMock = vi.fn();
const createRootMock = vi.fn(() => ({ render: renderMock }));

vi.mock('react-dom/client', () => ({
  createRoot: createRootMock,
}));

vi.mock('./App', () => ({
  default: () => null,
}));

describe('main entrypoint', () => {
  it('mounts app into root element', async () => {
    const root = document.createElement('div');
    root.id = 'root';
    document.body.appendChild(root);

    await import('./main');

    expect(createRootMock).toHaveBeenCalledWith(root);
    expect(renderMock).toHaveBeenCalled();
  });
});
