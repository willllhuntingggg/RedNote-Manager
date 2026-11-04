# Privacy Policy for RedNote Manager

*Last updated: November 4, 2026*

RedNote Manager ("the Extension") is committed to protecting your privacy. This Privacy Policy explains our practices regarding data collection and usage.

## 1. Data Collection and Usage
- **No Personal Data Collected:** The Extension does NOT collect, transmit, or sell your personal identification, login credentials, passwords, or personal browsing history to any developer or third-party server.
- **Local Browser Storage:** The Extension uses your browser's local storage (`chrome.storage.local`) exclusively to save your user preferences (speed, cooldown, custom keywords) and a record of processed note IDs so that completed actions can be undoable and not repeated. This data never leaves your device.
- **Direct Communication with Xiaohongshu:** Operations such as reading note cards and uncollecting/unliking are performed directly between your browser and Xiaohongshu servers (`xiaohongshu.com` / `rednote.com`) using your existing browser session. No middleman server is used.
- **Optional AI Categorization (DeepSeek):** If you choose to enable the AI classification feature, your API key and selected note titles are sent directly from your browser to the DeepSeek API (`api.deepseek.com`) to generate content categories and decision recommendations. The Extension author does not have access to your API key or the content sent.

## 2. Permissions Justification
- `storage`: Used to save settings, preferences, and processed note IDs locally on your computer.
- `sidePanel`: Used to display the management dashboard and search filters inside Chrome's native side panel.
- `https://*.xiaohongshu.com/*` & `https://*.rednote.com/*`: Required to read note elements on your profile page and execute uncollect/unlike actions that you confirm.
- `https://api.deepseek.com/*`: Required to request AI note categorization when you configure a DeepSeek API key.

## 3. Third-Party Sharing
The Extension does not share, transfer, or sell your data to any third parties for advertising or tracking purposes.

## 4. Changes to This Policy
We may update this Privacy Policy from time to time. Any changes will be posted in the Extension's public repository.

## 5. Contact
If you have any questions about this Privacy Policy, please open an issue in the project's repository.
