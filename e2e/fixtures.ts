import { test as base } from '@playwright/test'

// Logs browser-side console/network activity to stdout, which Playwright's
// reporter forwards into the CI job log — needed because this sandbox can't
// download the trace/artifact zip Playwright otherwise produces on failure.
export const test = base.extend({
  page: async ({ page }, use) => {
    page.on('console', (msg) => {
      console.log(`[browser:${msg.type()}] ${msg.text()}`)
    })
    page.on('pageerror', (err) => {
      console.log(`[browser:pageerror] ${err.message}`)
    })
    page.on('requestfailed', (req) => {
      console.log(
        `[browser:requestfailed] ${req.method()} ${req.url()} ${req.failure()?.errorText ?? ''}`,
      )
    })
    await use(page)
  },
})

export { expect } from '@playwright/test'
