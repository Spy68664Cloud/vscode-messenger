# VS Code Messenger
RPC messaging library for the VS Code extension platform

[![npm](https://img.shields.io/npm/v/vscode-messenger)](https://www.npmjs.com/package/vscode-messenger) [![CI](https://github.com/TypeFox/vscode-messenger/actions/workflows/main.yml/badge.svg)](https://github.com/TypeFox/vscode-messenger/actions/workflows/main.yml)

#### Supported features

- Sending notification or an async request from an extension to a view, a view group or broadcast to all registered views
- Sending notification or an async request from a view to an other view, a view group or the host extension
- Support for sync and async request/notification handlers
- Typed API
- Automatically unregister views on view dispose
- Configurable logging


#### Usage in an extension (TS example)

```ts
const messenger = new Messenger();

// register one or more views
messenger.registerWebviewView(webviewView);


// Handle incoming view notification
const colorSelectType: NotificationType<string> = { method: 'colorSelected' };

messenger.onNotification(colorSelectType, (params: string) => {
    vscode.window.activeTextEditor?.insertSnippet(new vscode.SnippetString(`#${params}`));
});

// Handle view requests and return a result
const availableColorsType: RequestType<string, string[]> = { method: 'availableColor' };

messenger.onRequest(availableColorsType, (params: string) => {
    return ['020202', 'f1eeee', 'a85b20', 'daab70', 'efcb99'];
});

// Send a notification to a view of type 'calicoColors.colorsView'
const colorModifyType: NotificationType<string> = { method: 'colorModify' };

messenger.sendNotification(colorModifyType, {type: 'webview', webviewType: 'calicoColors.colorsView' }, 'clear');


// Send a request to a view of type 'calicoColors.colorsView' and get a result
const selectedColor = await messenger.sendRequest({ method: 'getSelectedColor' }, {type: 'webview', webviewType: 'calicoColors.colorsView' }, '');
```


#### Usage in a webview (JS Example)

```js
const vscode = acquireVsCodeApi();
const vscode_messenger = require("vscode-messenger-webview");

const messenger = new vscode_messenger.Messenger(vscode);

// Handle extension Notifications. For requests use `onRequest()` 
messenger.onNotification({method: 'colorModify'}, (params) => {
    switch(params) {
        case 'add': {
            addColor();
            break;
        }
        case 'clear': {
            colors = [];
            updateColorList(colors);
            break;
        }
    }
});
messenger.start(); // start listening for incoming events

// Send a request to your extension.
// For notification use `sendNotification()`
 const colors = await messenger.sendRequest({ method: 'availableColors'}, HOST_EXTENSION, '');
 console.log(colors);

```
