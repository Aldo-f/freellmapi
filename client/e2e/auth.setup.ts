import { Page } from '@playwright/test';

export async function loginViaForm(page: Page) {
  await page.goto('/');
  // Server starts with no user → setup form appears
  await page.fill('#auth-email', 'test@example.com');
  await page.fill('#auth-password', 'password123');
  await page.click('button[type="submit"]');
  // Wait for auth to complete and dashboard to render
  await page.waitForURL('**/keys');
  await page.waitForSelector('text=Keys');
}