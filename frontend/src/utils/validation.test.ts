import { describe, expect, it } from 'vitest';
import {
  isAcceptedType,
  isImage,
  isPdf,
  validateBatchSize,
  validateFile,
} from './validation';

function makeFile(name: string, type: string, sizeBytes = 1024): File {
  const content = 'x'.repeat(Math.max(1, Math.floor(sizeBytes / 2)));
  return new File([content], name, { type });
}

describe('validation utils', () => {
  it('accepts supported image and pdf types', () => {
    expect(isAcceptedType(makeFile('a.png', 'image/png'))).toBe(true);
    expect(isAcceptedType(makeFile('a.pdf', 'application/pdf'))).toBe(true);
    expect(isAcceptedType(makeFile('a.txt', 'text/plain'))).toBe(false);
  });

  it('detects image vs pdf correctly', () => {
    expect(isImage(makeFile('a.jpg', 'image/jpeg'))).toBe(true);
    expect(isImage(makeFile('a.pdf', 'application/pdf'))).toBe(false);
    expect(isPdf(makeFile('a.pdf', 'application/pdf'))).toBe(true);
    expect(isPdf(makeFile('a.png', 'image/png'))).toBe(false);
  });

  it('rejects files larger than 20MB', () => {
    const over20Mb = new File([new Uint8Array(20 * 1024 * 1024 + 1)], 'large.png', {
      type: 'image/png',
    });
    const err = validateFile(over20Mb);
    expect(err).toContain('20 MB limit');
  });

  it('validates fast and slow batch limits', () => {
    expect(validateBatchSize(10, 'fast')).toBeNull();
    expect(validateBatchSize(11, 'fast')).toContain('Maximum 10 files');
    expect(validateBatchSize(50, 'slow')).toBeNull();
    expect(validateBatchSize(51, 'slow')).toContain('Maximum 50 files');
  });
});
