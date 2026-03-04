import { test, expect } from '@playwright/test';

test('upload and analyze flow works in browser', async ({ page }) => {
  await page.route('**/api/health**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        status: 'ok',
        model_loaded: true,
        model_name: 'mock-model',
        lm_studio_url: 'http://localhost:1234/v1',
      }),
    });
  });

  await page.route('**/api/analyze**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        summary: 'E2E summary',
        key_observations: ['obs'],
        content_classification: 'photograph',
        extracted_text: '',
        reasoning: '',
        reasoning_token_count: 0,
        finish_reason: 'stop',
        processing_time_ms: 64,
      }),
    });
  });

  await page.goto('/');
  await expect(page.getByText('Model Ready')).toBeVisible();

  await page.getByLabel('or click to browse').setInputFiles({
    name: 'sample.png',
    mimeType: 'image/png',
    buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO6q5mQAAAAASUVORK5CYII=', 'base64'),
  });

  await page.getByRole('button', { name: /Analyze 1 file/i }).click();
  await expect(page.getByText('E2E summary')).toBeVisible();
});
