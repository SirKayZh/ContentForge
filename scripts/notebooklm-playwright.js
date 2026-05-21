#!/usr/bin/env node
/**
 * NotebookLM Playwright Generator
 * 替代 CLI generate 命令（因 CLI HTTP 400 问题）
 *
 * 用法：
 *   node notebooklm-playwright.js <notebookId> <generateType> [outputDir]
 *
 * generateType: audio | video | report | mindmap | flashcards | quiz
 * outputDir: 可选，下载保存目录
 */

const { chromium } = require('/Users/dylanzheng/.nvm/versions/node/v24.13.0/lib/node_modules/playwright');
const fs = require('fs');
const path = require('path');

const STORAGE_STATE = '/Users/dylanzheng/.notebooklm/storage-state.json';
const OUTPUT_DIR = process.argv[4] || '/tmp/nlm-output';

// Generate type to UI label mapping
const TYPE_MAP = {
  audio: '音频概览',
  video: '视频概览',
  report: '报告',
  mindmap: '思维导图',
  flashcards: '学习卡',
  quiz: '小测验',
};

async function loadCookies(context) {
  const storageState = JSON.parse(fs.readFileSync(STORAGE_STATE, 'utf8'));
  const nlmCookies = storageState.cookies.filter(c =>
    c.domain.includes('notebooklm') || c.domain.includes('google')
  );

  for (const cookie of nlmCookies) {
    try {
      await context.addCookies([{
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain,
        path: cookie.path || '/',
        expires: cookie.expires,
        httpOnly: cookie.httpOnly || false,
        secure: cookie.secure || false,
        sameSite: cookie.sameSite || 'Lax',
      }]);
    } catch (e) { /* skip invalid cookies */ }
  }
}

async function waitForGeneration(page, type) {
  const labels = {
    audio: '音频概览',
    video: '视频概览',
    report: '报告',
    mindmap: '思维导图',
    flashcards: '学习卡',
    quiz: '小测验',
  };

  const label = labels[type] || type;
  console.log(`Waiting for ${label} generation to complete...`);

  // Poll for up to 5 minutes
  for (let i = 0; i < 60; i++) {
    await page.waitForTimeout(5000);

    const text = await page.evaluate(() => document.body.innerText);

    // Check if "生成中" (generating) is gone and something else appears
    if (!text.includes('正在生成') && !text.includes('Generating')) {
      if (text.includes('下载') || text.includes('Download') || text.includes(label)) {
        console.log(`✅ ${label} generation complete!`);
        return true;
      }
    }

    if (i % 6 === 0) {
      console.log(`  Still generating... (${i * 5}s elapsed)`);
    }
  }

  console.log('⚠️ Generation may still be in progress');
  return false;
}

async function downloadFile(page, filename) {
  // Wait for download link to appear
  const downloadBtn = await page.$('a[href*=".mp3"], a[href*=".mp4"], a[href*=".pdf"], a[href*=".zip"]');
  if (downloadBtn) {
    const href = await downloadBtn.getAttribute('href');
    console.log(`Download link found: ${href}`);

    // Save output path
    const outputPath = path.join(OUTPUT_DIR, filename);
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });

    // Download using fetch
    const response = await page.evaluate(async (url) => {
      const res = await fetch(url);
      return await res.arrayBuffer();
    }, href);

    fs.writeFileSync(outputPath, Buffer.from(response));
    console.log(`✅ Downloaded to: ${outputPath}`);
    return outputPath;
  }

  // Fallback: just save screenshot
  const screenshotPath = path.join(OUTPUT_DIR, `${filename.replace(/\.[^.]+$/, '')}.png`);
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  await page.screenshot({ path: screenshotPath, fullPage: true });
  console.log(`📸 Saved screenshot to: ${screenshotPath}`);
  return screenshotPath;
}

async function generate(notebookId, generateType, outputDir) {
  const OUTPUT_DIR = outputDir || process.argv[4] || '/tmp/nlm-output';
  const label = TYPE_MAP[generateType] || generateType;

  console.log(`\n🎙️ NotebookLM ${label} Generator`);
  console.log(`   Notebook: ${notebookId}`);
  console.log(`   Type: ${generateType}`);
  console.log(`   Output: ${OUTPUT_DIR}\n`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  await loadCookies(context);

  const page = await context.newPage();

  try {
    // Open notebook
    console.log('Opening notebook...');
    await page.goto(`https://notebooklm.google.com/notebook/${notebookId}`, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    // FIRST: Remove all blocking overlays before ANY click attempts
    console.log('Removing blocking overlays...');
    await page.evaluate(() => {
      const overlays = document.querySelectorAll('.cdk-overlay-container, [class*="overlay-backdrop"], .mat-mdc-dialog-container, [role="dialog"]');
      overlays.forEach(el => el.remove());
      // Also clear any body styles that might block clicks
      document.body.style.overflow = 'auto';
      document.body.style.position = 'static';
    });
    await page.waitForTimeout(1000);

    // Close "试试看" banner if present
    console.log('Looking for banner/close button...');
    const closeBannerBtn = await page.$('button[aria-label="关闭横幅"], button:has-text("close"), button:has-text("关闭")');
    if (closeBannerBtn) {
      try {
        await closeBannerBtn.click({ timeout: 3000 });
        console.log('Closed banner');
        await page.waitForTimeout(1000);
      } catch (e) {
        // Try JS click
        await page.evaluate(() => {
          const btn = Array.from(document.querySelectorAll('button')).find(b => 
            b.getAttribute('aria-label')?.includes('关闭') ||
            b.textContent?.includes('close')
          );
          if (btn) btn.click();
        });
        await page.waitForTimeout(1000);
      }
    }

    // Remove overlays again after any interactions
    await page.evaluate(() => {
      const overlays = document.querySelectorAll('.cdk-overlay-container, [class*="overlay-backdrop"], .mat-mdc-dialog-container, [role="dialog"]');
      overlays.forEach(el => el.remove());
    });
    await page.waitForTimeout(500);

    // Now close any banner
    console.log('Looking for banner close button...');
    const closeBtn = await page.$('button[aria-label*="关闭"], button[aria-label*="close" i]');
    if (closeBtn) {
      try {
        await closeBtn.click({ timeout: 5000 });
        await page.waitForTimeout(1000);
        console.log('Closed banner');
      } catch (e) {
        // If Playwright click fails, try JS click
        await page.evaluate(() => {
          const btn = Array.from(document.querySelectorAll('button')).find(b => 
            b.getAttribute('aria-label')?.includes('关闭') || 
            b.getAttribute('aria-label')?.toLowerCase().includes('close')
          );
          if (btn) btn.click();
        });
        await page.waitForTimeout(1000);
      }
    }

    // Click using JavaScript (bypasses overlay interception issues)
    // The button has aria-label="自定义音频概览" - so we look for elements containing "音频概览"
    console.log(`Clicking ${label} via JS...`);
    const clicked = await page.evaluate((labelText) => {
      // Try finding by aria-label containing the text
      const byAria = Array.from(document.querySelectorAll('[aria-label*="音频"]'));
      if (byAria.length > 0) {
        byAria[0].click();
        return 'aria:' + byAria[0].getAttribute('aria-label');
      }
      // Try finding by text content in buttons
      const byText = Array.from(document.querySelectorAll('button, [role="button"]')).filter(b => 
        b.textContent.includes(labelText)
      );
      if (byText.length > 0) {
        byText[0].click();
        return 'text:' + byText[0].textContent.trim();
      }
      return null;
    }, label);
    
    if (!clicked) {
      throw new Error(`Could not find ${label} button`);
    }
    
    console.log(`Clicked: ${clicked}`);
    await page.waitForTimeout(2000);

    // Click Generate button using JS as well
    const generateResult = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button'));
      const btn = buttons.find(b => b.textContent.includes('生成') || b.textContent.includes('Create'));
      if (btn) {
        btn.click();
        return true;
      }
      return false;
    });
    if (generateResult) {
      console.log('Clicked Generate via JS');
      await page.waitForTimeout(5000);
    }

    // Wait for generation
    await waitForGeneration(page, generateType);

    // Take screenshot of result
    const screenshotPath = path.join(OUTPUT_DIR, `${generateType}_result.png`);
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    await page.screenshot({ path: screenshotPath, fullPage: true });
    console.log(`📸 Screenshot: ${screenshotPath}`);

    // Try to download
    const dlPath = await downloadFile(page, `${notebookId}_${generateType}`);
    console.log(`\n✅ Done! Output: ${dlPath}`);

  } catch (error) {
    console.error(`❌ Error: ${error.message}`);
    throw error;
  } finally {
    await browser.close();
  }
}

// Main
const notebookId = process.argv[2];
const generateType = process.argv[3] || 'audio';

if (!notebookId) {
  console.log(`
NotebookLM Playwright Generator

用法：
  node notebooklm-playwright.js <notebookId> <generateType> [outputDir]

参数：
  notebookId    NotebookLM 笔记本 ID
  generateType  audio | video | report | mindmap | flashcards | quiz
  outputDir     可选，输出目录

示例：
  node notebooklm-playwright.js 31be8f34-xxx audio
  node notebooklm-playwright.js 31be8f34-xxx report /tmp/results
`);
  process.exit(1);
}

generate(notebookId, generateType, process.argv[4])
  .then(() => process.exit(0))
  .catch(() => process.exit(1));
