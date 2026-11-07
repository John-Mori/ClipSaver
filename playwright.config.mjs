import { defineConfig } from '@playwright/test';

const liveBaseURL = process.env.CLIPSAVER_BASE_URL;

export default defineConfig({
  testDir: './tests',
  testMatch: 'ui.spec.mjs',
  timeout: 30_000,
  fullyParallel: false,
  reporter: 'line',
  use: {
    baseURL: liveBaseURL || 'http://127.0.0.1:18790',
    locale: 'ja-JP'
  },
  webServer: liveBaseURL ? undefined : {
    command: 'python -c "import os,runpy; os.environ[\'CLIPSAVER_PORT\']=\'18790\'; runpy.run_path(\'local/server.py\',run_name=\'__main__\')"',
    url: 'http://127.0.0.1:18790/',
    reuseExistingServer: false,
    timeout: 30_000
  },
  projects: [
    {
      name: 'pc-chromium',
      use: { browserName: 'chromium', viewport: { width: 1280, height: 900 } }
    },
    {
      name: 'iphone-webkit',
      use: {
        browserName: 'webkit',
        viewport: { width: 390, height: 844 },
        userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1'
      }
    }
  ]
});
