import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { LanguageProvider } from '../contexts/LanguageContext';
import { UploadZone } from './UploadZone';

const dropState = {
  isDragActive: false,
};

vi.mock('react-dropzone', () => ({
  useDropzone: (opts: { onDrop: (files: File[]) => void; disabled?: boolean }) => ({
    getRootProps: () => ({
      onClick: () => opts.onDrop([new File(['a'], 'a.png', { type: 'image/png' })]),
    }),
    getInputProps: () => ({}),
    isDragActive: dropState.isDragActive,
  }),
}));

describe('UploadZone', () => {
  it('calls onFilesAdded when dropped', () => {
    const onFilesAdded = vi.fn();
    render(
      <LanguageProvider>
        <UploadZone onFilesAdded={onFilesAdded} />
      </LanguageProvider>
    );

    fireEvent.click(screen.getByRole('button'));
    expect(onFilesAdded).toHaveBeenCalledTimes(1);
  });

  it('shows drag active label', () => {
    dropState.isDragActive = true;
    render(
      <LanguageProvider>
        <UploadZone onFilesAdded={() => {}} />
      </LanguageProvider>
    );

    expect(screen.getByText(/Drop files here/i)).toBeInTheDocument();
    dropState.isDragActive = false;
  });
});
