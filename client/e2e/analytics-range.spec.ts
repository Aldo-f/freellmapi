import { test, expect } from '@playwright/test'
import { loginViaForm } from './auth.setup'

test.describe.serial('analytics time range persistence', () => {
  test('first visit defaults to 7d', async ({ page }) => {
    await loginViaForm(page)
    await page.goto('/analytics')
    await page.evaluate(() => localStorage.removeItem('analytics-time-range'))
    await page.reload()
    await page.waitForLoadState('networkidle')
    const btn7d = page.locator('button', { hasText: '7d' })
    await expect(btn7d).toHaveClass(/secondary/)
  })

  test('selected range persists after full page reload', async ({ page }) => {
    await loginViaForm(page)
    await page.goto('/analytics')
    await page.waitForLoadState('networkidle')
    await page.locator('button', { hasText: '24h' }).click()
    await expect(page.locator('button', { hasText: '24h' })).toHaveClass(/secondary/)
    await page.reload()
    await page.waitForLoadState('networkidle')
    await expect(page.locator('button', { hasText: '24h' })).toHaveClass(/secondary/)
  })

  test('selected range persists after SPA navigation', async ({ page }) => {
    await loginViaForm(page)
    await page.goto('/analytics')
    await page.waitForLoadState('networkidle')
    await page.locator('button', { hasText: '30d' }).click()
    await expect(page.locator('button', { hasText: '30d' })).toHaveClass(/secondary/)
    await page.getByRole('link', { name: 'Keys' }).click()
    await page.waitForURL('**/keys')
    await page.getByRole('link', { name: 'Analytics' }).click()
    await page.waitForURL('**/analytics')
    await page.waitForLoadState('networkidle')
    await expect(page.locator('button', { hasText: '30d' })).toHaveClass(/secondary/)
  })

  test('corrupted localStorage falls back to default', async ({ page }) => {
    await loginViaForm(page)
    await page.goto('/analytics')
    await page.waitForLoadState('networkidle')
    await page.evaluate(() => localStorage.setItem('analytics-time-range', '{invalid json:::}'))
    await page.reload()
    await page.waitForLoadState('networkidle')
    await expect(page.locator('button', { hasText: '7d' })).toHaveClass(/secondary/)
    await expect(page.getByText('Requests')).toBeVisible()
    await expect(page.getByText('Success rate')).toBeVisible()
  })
})