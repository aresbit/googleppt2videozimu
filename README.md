# Google Vids 字幕翻译插件

这是一个最小可用的 Chrome 扩展，目标是：

- 在 `https://docs.google.com/videos/*` 页面运行
- 尝试识别 `All scenes` 附近的英文字幕文本
- 调用 Google Translate 接口翻译为中文
- 把中文插入到英文字幕下方，方便对照学习

## 文件说明

- `manifest.json`：Chrome 扩展配置
- `background.js`：负责请求翻译和本地缓存
- `content.js`：负责在页面里扫描字幕并插入中文
- `content.css`：面板和译文样式

## 安装

1. 打开 Chrome
2. 进入 `chrome://extensions/`
3. 打开右上角“开发者模式”
4. 点击“加载已解压的扩展程序”
5. 选择当前目录 `C:\yyscode\zimu`

## 使用

1. 打开你的 Google Vids 页面
2. 等页面加载完成后，右下角会出现“字幕翻译助手”
3. 如果没有立刻出现中文，点击“重新扫描”
4. 如果页面 DOM 结构发生变化，刷新页面后再试一次

## 当前实现说明

这个版本使用的是启发式识别：

- 优先寻找带有 `All scenes` 文本附近的容器
- 从附近的 `div / span / p` 里筛选看起来像英文字幕的文本
- 避开纯时间、纯数字和已是中文的内容

所以第一版可能会有两类情况：

- 有些字幕没抓到
- 抓到了一些不是字幕的英文 UI 文本

这都正常。下一步最适合做的是：

- 用真实页面结构精确定位字幕节点
- 加“只翻译鼠标悬停块”或“只翻译当前场景”模式
- 做一个 popup 设置页，让你切换中英排版方式

## 注意

`translate.googleapis.com` 这个调用方式在实践中常能工作，但它不是正式的付费 Cloud Translation SDK 接入方式。如果你后面想做得更稳定，我可以再帮你改成：

- 接入你自己的 Google Cloud Translation API Key
- 或改成本地/中转服务
