import { test, expect } from '@playwright/test';

test.describe('Insurance Comparison Quote Funnel (Sample Suite for System 1 Triage)', () => {
  test('1. Product Defect: calculates monthly hospital + extras rebate correctly', async ({ page }) => {
    await page.setContent(`
      <div data-testid="quote-summary">
        <span data-testid="monthly-premium">$219.00/mo</span>
      </div>
    `);
    const actualPrice = await page.getByTestId('monthly-premium').textContent();
    expect(actualPrice).toBe('$184.20/mo');
  });

  test('2. Broken Locator: clicking Compare Quotes CTA triggers strict mode violation', async ({ page }) => {
    await page.setContent(`
      <header><button>Compare Quotes</button></header>
      <footer><button>Compare Quotes</button></footer>
    `);
    await page.getByRole('button', { name: 'Compare Quotes' }).click();
  });

  test('3. Flaky Timing: animated cookie banner backdrop intercepts pointer click', async ({ page }) => {
    await page.setContent(`
      <div style="position:relative;">
        <button id="continue-btn">Continue to Extras</button>
        <div class="cookie-banner-backdrop animating" style="position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:9999;">
          Cookie Consent Drawer Animating...
        </div>
      </div>
    `);
    await page.locator('#continue-btn').click({ timeout: 1500 });
  });

  test('4. Environment / Network: upstream quote gateway returns 503 Service Unavailable', async () => {
    throw new Error(
      'APIRequestContext.post: 503 Service Unavailable at https://staging-api.example.internal/v2/quotes'
    );
  });

  test('5. Auth / Test Data: expired OAuth session token returns 401 Unauthorized', async () => {
    throw new Error(
      'Response status 401 Unauthorized from GET /api/v1/member/saved-quotes: JWT expired'
    );
  });

  test('6. Test Code Error: undefined fixture property access inside spec', async () => {
    const brokenFixture: Record<string, { nmiNumber: string }> = {};
    const nmi = brokenFixture.energyAccount.nmiNumber;
    expect(nmi).toBeDefined();
  });
});
