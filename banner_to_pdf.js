const puppeteer = require('puppeteer');
const path = require('path');

(async () => {
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  
  const filePath = path.resolve(__dirname, 'ablespeak_banner_v4.html');
  await page.goto('file:///' + filePath.replace(/\\/g, '/'), { waitUntil: 'load', timeout: 15000 });

  // Wait a moment for fonts/images
  await new Promise(r => setTimeout(r, 2000));

  // Hide the label, clean up body
  await page.evaluate(() => {
    const label = document.querySelector('.label');
    if (label) label.style.display = 'none';
    document.body.style.padding = '0';
    document.body.style.margin = '0';
    document.body.style.background = 'white';
  });

  const bannerBox = await page.evaluate(() => {
    const el = document.querySelector('.banner');
    const rect = el.getBoundingClientRect();
    return { width: rect.width, height: rect.height };
  });

  await page.pdf({
    path: path.resolve(__dirname, 'ablespeak_banner_v4.pdf'),
    width: Math.ceil(bannerBox.width + 40) + 'px',
    height: Math.ceil(bannerBox.height + 40) + 'px',
    printBackground: true,
    margin: { top: '20px', bottom: '20px', left: '20px', right: '20px' }
  });

  console.log('PDF saved to: ablespeak_banner_v4.pdf');
  await browser.close();
})();
