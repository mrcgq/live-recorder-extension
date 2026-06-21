# 🎬 直播内录器 - Live Stream Recorder

> 浏览器扩展插件 | 支持 Chrome / Edge | 无需安装软件

![version](https://img.shields.io/badge/version-2.0.0-red)
![manifest](https://img.shields.io/badge/manifest-v3-blue)
![license](https://img.shields.io/badge/license-MIT-green)

---

## ✨ 功能特性

| 功能 | 说明 |
|------|------|
| 🎯 网页直播内录 | 直接捕获标签页视频+音频，无需第三方软件 |
| 📊 三档画质 | 超清(12Mbps) / 高清(6Mbps) / 标清(2.5Mbps) |
| 🎵 音频内录 | 系统声音 + 麦克风混合录制 |
| 🔲 区域录制 | 鼠标拖拽选择录制区域 |
| 🪟 悬浮控制条 | 可拖拽的浮动控制面板 |
| ⌨️ 快捷键 | Alt+R 开始/停止，Alt+P 暂停 |
| 💾 自动保存 | 录制结束自动下载到本地 |
| 📦 分段录制 | 超过设定大小自动分段保存 |

---

## 📦 安装方法

### 方式一：直接下载安装（推荐）

1. 点击右上角 **Code → Download ZIP**
2. 解压到任意文件夹
3. **先运行 `generate_icons.html`** 生成图标文件
   - 在浏览器中打开此文件
   - 点击"一键生成全部图标"
   - 将3个图标放入 `icons/` 文件夹
4. 打开浏览器，进入扩展管理页：
   - Chrome: `chrome://extensions/`
   - Edge:   `edge://extensions/`
5. 开启右上角 **开发者模式**
6. 点击 **加载已解压的扩展程序**
7. 选择解压后的文件夹
8. ✅ 安装完成！

### 方式二：克隆仓库

```bash
git clone https://github.com/你的用户名/live-recorder-extension.git
cd live-recorder-extension
# 用浏览器打开 generate_icons.html 生成图标
# 然后在浏览器扩展页加载此文件夹
