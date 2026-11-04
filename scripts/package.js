#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const rootDir = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
const version = pkg.version || '0.2.0';

const distDir = path.join(rootDir, 'dist');
const targetDir = path.join(distDir, 'rednote-manager');
const zipFileName = `rednote-manager-v${version}.zip`;
const zipFilePath = path.join(distDir, zipFileName);
const cwsZipFileName = `rednote-manager-v${version}-cws.zip`;
const cwsZipFilePath = path.join(distDir, cwsZipFileName);

console.log(`[Package] 开始构建 RedNote Manager v${version} 发布包...`);

// 1. 清理旧产物
if (fs.existsSync(targetDir)) {
  fs.rmSync(targetDir, { recursive: true, force: true });
}
if (fs.existsSync(zipFilePath)) {
  fs.rmSync(zipFilePath, { force: true });
}
if (fs.existsSync(cwsZipFilePath)) {
  fs.rmSync(cwsZipFilePath, { force: true });
}
fs.mkdirSync(targetDir, { recursive: true });

// 2. 复制函数（过滤 .DS_Store、测试文件及商店宣传海报资源）
function copyRecursive(src, dest) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    const entries = fs.readdirSync(src);
    for (const entry of entries) {
      if (entry === '.DS_Store' || entry === '__tests__' || entry === 'cws' || entry.endsWith('.test.js')) continue;
      copyRecursive(path.join(src, entry), path.join(dest, entry));
    }
  } else {
    if (path.basename(src) === '.DS_Store') return;
    fs.copyFileSync(src, dest);
  }
}

// 3. 复制核心文件（仅复制扩展运行必需文件）
const filesToCopy = ['manifest.json', 'assets', 'src'];
for (const item of filesToCopy) {
  const srcPath = path.join(rootDir, item);
  if (fs.existsSync(srcPath)) {
    copyRecursive(srcPath, path.join(targetDir, item));
    console.log(`[Package] 已复制核心目录: ${item}`);
  }
}

// 4. 写入极简安装说明
const installDoc = `RedNote Manager (小红书批量整理助手) · 浏览器安装说明
=========================================================

这是一个适用于 Chrome、Edge 及各类 Chromium 内核浏览器的扩展程序。

【4 步快速安装教程】

步骤 1：解压压缩包
  - 将本 zip 压缩包解压到一个固定的文件夹中（例如电脑的“下载”或“文稿”目录）。
  - 解压后会看到包含 manifest.json、src、assets 等文件的 rednote-manager 文件夹。

步骤 2：打开浏览器扩展管理页
  - 在 Chrome / Edge 浏览器地址栏中输入：
      chrome://extensions
    然后按回车进入。

步骤 3：开启“开发者模式”
  - 在扩展管理页面的【右上角】，找到并打开「开发者模式」(Developer mode) 开关。

步骤 4：加载扩展程序
  - 打开开发者模式后，页面左上方会出现「加载已解压的扩展程序」(Load unpacked) 按钮。
  - 点击该按钮，在弹出的文件选择器中选择刚刚解压出的【rednote-manager】文件夹（即包含 manifest.json 的那个文件夹）。
  - 点击“选择”/“确定”。

恭喜！安装完成！
打开小红书网页版 (https://www.xiaohongshu.com/) 即可看到右下角浮动条与 Chrome 右上角原生侧边栏图标。
`;

fs.writeFileSync(path.join(targetDir, 'INSTALL.txt'), installDoc, 'utf8');
console.log('[Package] 已生成: INSTALL.txt');

// 5. 生成两套 zip 压缩包
console.log(`[Package] 正在生成开发者模式分发包: ${zipFileName}...`);
try {
  // A. 开发者模式专用分发包：解压后直接为 rednote-manager 文件夹，方便朋友解压后一键加载
  execSync(`cd "${distDir}" && zip -r -q "${zipFileName}" rednote-manager -x "*.DS_Store"`, { stdio: 'inherit' });
  const stat1 = fs.statSync(zipFilePath);
  const sizeKb1 = (stat1.size / 1024).toFixed(1);

  // B. Chrome Web Store / 扩展商店专用上传包：manifest.json 必须位于 zip 的根目录！
  console.log(`[Package] 正在生成 Chrome Web Store 商店专用上传包: ${cwsZipFileName}...`);
  execSync(`cd "${targetDir}" && zip -r -q "${cwsZipFilePath}" * -x "*.DS_Store" -x "INSTALL.txt"`, { stdio: 'inherit' });
  const stat2 = fs.statSync(cwsZipFilePath);
  const sizeKb2 = (stat2.size / 1024).toFixed(1);

  console.log(`\n🎉 打包成功！`);
  console.log(`📦 [发给朋友使用]   ${zipFilePath} (${sizeKb1} KB)`);
  console.log(`🚀 [上传应用商店专用] ${cwsZipFilePath} (${sizeKb2} KB)`);
  console.log(`📁 [已解压源目录]   ${targetDir}\n`);
} catch (err) {
  console.error('[Package] zip 命令打包失败:', err.message);
  process.exit(1);
}
