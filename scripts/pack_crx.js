#!/usr/bin/env node
/**
 * 使用本机 Chrome 官方引擎打包生成 .crx 扩展安装包及配套 .pem 签名私钥
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const rootDir = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
const version = pkg.version || '0.1.0';

const distDir = path.join(rootDir, 'dist');
const stageDir = path.join(distDir, 'crx-staging');
const crxFileName = `rednote-manager-v${version}.crx`;
const destCrxPath = path.join(distDir, crxFileName);
const pemKeyPath = path.join(distDir, 'rednote-manager.pem');

// 1. 查找 Chrome 可执行文件路径
function findChromeExecutable() {
  const platform = process.platform;
  if (platform === 'darwin') {
    const defaultMacPath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    if (fs.existsSync(defaultMacPath)) return defaultMacPath;
  } else if (platform === 'win32') {
    const candidates = [
      process.env['PROGRAMFILES'] + '\\Google\\Chrome\\Application\\chrome.exe',
      process.env['PROGRAMFILES(X86)'] + '\\Google\\Chrome\\Application\\chrome.exe',
      process.env['LOCALAPPDATA'] + '\\Google\\Chrome\\Application\\chrome.exe'
    ];
    for (const p of candidates) {
      if (p && fs.existsSync(p)) return p;
    }
  } else {
    // Linux
    for (const bin of ['google-chrome', 'google-chrome-stable', 'chromium-browser', 'chromium']) {
      try {
        const p = execSync(`which ${bin} 2>/dev/null`, { encoding: 'utf8' }).trim();
        if (p && fs.existsSync(p)) return p;
      } catch (e) {}
    }
  }
  return null;
}

const chromeBin = findChromeExecutable();
if (!chromeBin) {
  console.error('[Error] 未检测到 Google Chrome 浏览器，无法调用原生 --pack-extension。');
  process.exit(1);
}

// 2. 准备纯净 staging 目录
fs.mkdirSync(distDir, { recursive: true });
fs.rmSync(stageDir, { recursive: true, force: true });
fs.mkdirSync(stageDir, { recursive: true });

function copyRecursive(src, dest) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      if (entry === '.DS_Store' || entry === '__tests__' || entry === 'cws' || entry.endsWith('.test.js')) continue;
      copyRecursive(path.join(src, entry), path.join(dest, entry));
    }
  } else {
    if (path.basename(src) === '.DS_Store') return;
    fs.copyFileSync(src, dest);
  }
}

for (const item of ['manifest.json', 'assets', 'src']) {
  const srcPath = path.join(rootDir, item);
  if (fs.existsSync(srcPath)) {
    copyRecursive(srcPath, path.join(stageDir, item));
  }
}

// 3. 执行打包
let packCmd = `"${chromeBin}" --headless --pack-extension="${stageDir}"`;
const rootPem = path.join(rootDir, 'rednote-manager.pem');
const effectivePem = fs.existsSync(pemKeyPath) ? pemKeyPath : (fs.existsSync(rootPem) ? rootPem : null);

if (effectivePem) {
  console.log(`[Pack CRX] 检测到已有签名私钥: ${effectivePem}，将复用以保持扩展 ID 不变...`);
  packCmd += ` --pack-extension-key="${effectivePem}"`;
} else {
  console.log(`[Pack CRX] 首次打包，Chrome 将自动生成签名私钥 (*.pem)...`);
}

try {
  execSync(packCmd, { stdio: 'inherit' });
} catch (err) {
  console.error('[Error] Chrome 打包失败:', err.message);
  process.exit(1);
}

// 4. 重命名并整理产物
const defaultGeneratedCrx = `${stageDir}.crx`;
const defaultGeneratedPem = `${stageDir}.pem`;

if (fs.existsSync(defaultGeneratedCrx)) {
  fs.renameSync(defaultGeneratedCrx, destCrxPath);
}
if (fs.existsSync(defaultGeneratedPem)) {
  fs.renameSync(defaultGeneratedPem, pemKeyPath);
}
fs.rmSync(stageDir, { recursive: true, force: true });

console.log(`\n========================================`);
console.log(`✓ CRX 安装包已成功生成: ${destCrxPath}`);
if (fs.existsSync(pemKeyPath)) {
  console.log(`✓ 签名私钥位置: ${pemKeyPath}`);
  console.log(`  (请妥善保管 .pem 文件，后续版本升级复用该 key 可保持插件 ID 和存储数据一致)`);
}
console.log(`========================================\n`);
