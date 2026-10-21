import { defineConfig, devices } from '@playwright/test';
import chromium from '@sparticuz/chromium';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const directory=mkdtempSync(join(tmpdir(),'opora-browser-'));
export default defineConfig({
  testDir:'./tests/browser',fullyParallel:false,workers:1,retries:0,reporter:'list',timeout:30000,
  use:{baseURL:'http://127.0.0.1:3101',launchOptions:{executablePath:await chromium.executablePath(),args:chromium.args},screenshot:'only-on-failure',trace:'retain-on-failure'},
  projects:[{name:'desktop',use:{...devices['Desktop Chrome'],viewport:{width:1440,height:1100},baseURL:'http://127.0.0.1:3101'}},{name:'mobile',use:{...devices['iPhone 13'],defaultBrowserType:'chromium',baseURL:'http://127.0.0.1:3102'}}],
  webServer:[3101,3102].map(port=>({command:`OPORA_INITIAL_IMPORT=tests/fixtures/sales.json OPORA_DB=${directory}/database-${port}.sqlite HOST=127.0.0.1 PORT=${port} npm start`,url:`http://127.0.0.1:${port}/api/health`,reuseExistingServer:false,timeout:30000}))
});
