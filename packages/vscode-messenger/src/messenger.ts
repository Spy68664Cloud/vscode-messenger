/******************************************************************************
 * Copyright 2022 TypeFox GmbH
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 ******************************************************************************/

import * as vscode from 'vscode';
import {
    isMessage, isNotificationMessage, isRequestMessage, isResponseMessage, JsonAny, Message, MessageParticipant,
    MessengerAPI, NotificationHandler, NotificationMessage, NotificationType, RequestHandler, RequestMessage,
    RequestType, ResponseError, ResponseMessage
} from 'vscode-messenger-common';

export class Messenger implements MessengerAPI {

    protected readonly idProvider: IdProvider = new IdProvider();

    protected readonly viewTypeRegistry: Map<string, Set<ViewContainer>> = new Map();

    // TODO use BiMap?
    protected readonly viewRegistry: Map<string, ViewContainer> = new Map();
    protected readonly idRegistry: Map<ViewContainer, string> = new Map();

    protected readonly handlerRegistry: Map<string, RequestHandler<unknown, unknown> | NotificationHandler<unknown>> = new Map();

    protected readonly requests: Map<string, RequestData> = new Map();

    protected readonly options: MessengerOptions;

    constructor(options?: MessengerOptions) {
        const defaultOptions: MessengerOptions = {
            ignoreHiddenViews: true,
            debugLog: false
        };
        this.options = { ...defaultOptions, ...options };
    }

    registerWebviewPanel(panel: vscode.WebviewPanel): void {
        this.registerViewContainer(panel);
    }

    registerWebviewView(view: vscode.WebviewView): void {
        this.registerViewContainer(view);
    }

    protected registerViewContainer(view: ViewContainer): void {
        view.onDidDispose(() => {
            const storedId = this.idRegistry.get(view);
            if (storedId) {
                this.viewRegistry.delete(storedId);
                this.idRegistry.delete(view);
            }
            const removed = this.viewTypeRegistry.get(view.viewType)?.delete(view);
            if (!removed) {
                this.log(`Attempt to remove non-existing registry entry for View: ${view.title} (type ${view.viewType})`, 'warn');
            }
        });

        // Register typed view
        const viewTypeEntry = this.viewTypeRegistry.get(view.viewType);
        if (viewTypeEntry) {
            viewTypeEntry.add(view);
        } else {
            this.viewTypeRegistry.set(view.viewType, new Set<ViewContainer>([view]));
        }

        // Add viewId mapping
        const viewId: string = this.idProvider.getWebviewId(view);
        this.viewRegistry.set(viewId, view);
        this.idRegistry.set(view, viewId);

        view.webview.onDidReceiveMessage(async (msg: unknown) => {
            if (isMessage(msg)) {
                if (!msg.sender) {
                    msg.sender = {
                        webviewId: viewId,
                        webviewType: view.viewType
                    };
                }
                return this.processMessage(msg, res => view.webview.postMessage(res))
                    .catch(err => this.log(String(err), 'error'));
            }
        });
    }

    /**
     * Process an incoming message by forwarding it to the respective receiver or handling it with
     * a locally registered message handler.
     */
    protected async processMessage(msg: Message, responseCallback: (res: Message) => Thenable<boolean>): Promise<void> {
        if (msg.receiver.webviewId) {
            // The message is directed to a specific webview
            const receiverView = this.viewRegistry.get(msg.receiver.webviewId);
            if (receiverView) {
                const result = await receiverView.webview.postMessage(msg);
                if (!result) {
                    this.log(`Failed to forward message to view: ${msg.receiver.webviewId}`, 'error');
                }
            } else {
                this.log(`No webview with id ${msg.receiver.webviewId} is registered.`, 'warn');
            }
        } else if (msg.receiver.webviewType) {
            // The message is directed to all webviews of a specific type
            const receiverViews = this.viewTypeRegistry.get(msg.receiver.webviewType);
            if (receiverViews) {
                receiverViews.forEach(async view => {
                    const result = await view.webview.postMessage(msg);
                    if (!result) {
                        this.log(`Failed to forward message to view: ${msg.receiver.webviewType}`, 'error');
                    }
                });
            } else {
                this.log(`No webview with type ${msg.receiver.webviewType} is registered.`, 'warn');
            }
        } else if (isRequestMessage(msg)) {
            await this.processRequestMessage(msg, responseCallback);
        } else if (isNotificationMessage(msg)) {
            await this.processNotificationMessage(msg);
        } else if (isResponseMessage(msg)) {
            await this.processResponseMessage(msg);
        } else {
            this.log(`Invalid message: ${msg}`, 'error');
        }
    }

    /**
     * Process an incoming request message with a registered handler.
     */
    protected async processRequestMessage(msg: RequestMessage, responseCallback: (res: Message) => Thenable<boolean>): Promise<void> {
        this.log(`Host received Request message: ${msg.method} (id ${msg.id})`);
        const handler = this.handlerRegistry.get(msg.method);
        if (!handler) {
            this.log(`Received request with unknown method: ${msg.method}`);
            return;
        }

        const sender: MessageParticipant = {}; // Specifies the host extension
        try {
            const result = await handler(msg.params, msg.sender!);
            const response: ResponseMessage = {
                id: msg.id,
                sender,
                receiver: msg.sender!,
                result: result as JsonAny
            };
            const posted = await responseCallback(response);
            if (!posted) {
                this.log(`Failed to send result message: ${participantToString(response.receiver)}`, 'error');
            }
        } catch (error) {
            const response: ResponseMessage = {
                id: msg.id,
                sender,
                receiver: msg.sender!,
                error: this.createResponseError(error)
            };
            const posted = await responseCallback(response);
            if (!posted) {
                this.log(`Failed to send error message: ${participantToString(response.receiver)}`, 'error');
            }
        }
    }

    protected createResponseError(error: unknown): ResponseError {
        if (error instanceof Error) {
            return { message: error.message, data: error.stack };
        } else if (typeof error === 'object' && error !== null && typeof (error as ResponseError).message === 'string') {
            return { message: (error as ResponseError).message, data: (error as ResponseError).data };
        } else {
            return { message: String(error) };
        }
    }

    /**
     * Process an incoming notification message with a registered handler.
     */
    protected async processNotificationMessage(msg: NotificationMessage): Promise<void> {
        this.log(`Host received Notification message: ${msg.method} `);
        const handler = this.handlerRegistry.get(msg.method);
        if (handler) {
            await handler(msg.params, msg.sender!);
        } else {
            this.log(`Received notification with unknown method: ${msg.method}`);
        }
    }

    /**
     * Process an incoming response message by resolving or rejecting the associated promise.
     */
    protected async processResponseMessage(msg: ResponseMessage): Promise<void> {
        this.log(`Host received Response message: ${msg.id} `);
        const request = this.requests.get(msg.id);
        if (request) {
            if (msg.error) {
                request.reject(msg.error);
            } else {
                request.resolve(msg.result);
            }
            this.requests.delete(msg.id);
        } else {
            this.log(`Received response for untracked message id: ${msg.id} (participant: ${participantToString(msg.sender!)})`, 'warn');
        }
    }

    onRequest<P extends JsonAny, R>(type: RequestType<P, R>, handler: RequestHandler<P, R>): void {
        if (this.handlerRegistry.has(type.method)) {
            this.log(`A request handler is already registered for method ${type.method} and will be overridden.`, 'warn');
        }
        this.handlerRegistry.set(type.method, handler as RequestHandler<unknown, unknown>);
    }

    onNotification<P extends JsonAny>(type: NotificationType<P>, handler: NotificationHandler<P>): void {
        if (this.handlerRegistry.has(type.method)) {
            this.log(`A notification handler is already registered for method ${type.method} and will be overridden.`, 'warn');
        }
        this.handlerRegistry.set(type.method, handler as NotificationHandler<unknown>);
    }

    async sendRequest<P extends JsonAny, R>(type: RequestType<P, R>, receiver: MessageParticipant, params: P): Promise<R> {
        if (receiver.webviewId) {
            const receiverView = this.viewRegistry.get(receiver.webviewId);
            if (receiverView) {
                return this.sendRequestToWebview(type, receiver, params, receiverView);
            } else {
                return Promise.reject(new Error(`No webview with id ${receiver.webviewId} is registered.`));
            }
        } else if (receiver.webviewType) {
            const receiverViews = this.viewTypeRegistry.get(receiver.webviewType);
            if (receiverViews) {
                // If there are multiple views, we make a race: the first view to return a result wins
                const results = Array.from(receiverViews).map(view => this.sendRequestToWebview(type, receiver, params, view));
                return Promise.race(results);
            } else {
                return Promise.reject(new Error(`No webview with type ${receiver.webviewType} is registered.`));
            }
        } else {
            throw new Error('A request needs a receiver; neither webviewId nor webviewType was set.');
        }
    }

    protected async sendRequestToWebview<P extends JsonAny, R>(type: RequestType<P, R>, receiver: MessageParticipant, params: P, view: ViewContainer): Promise<R> {
        // Messages are only delivered if the webview is live (either visible or in the background with `retainContextWhenHidden`).
        if (!view.visible && this.options.ignoreHiddenViews) {
            return Promise.reject(new Error(`Skipped request for hidden view: ${participantToString(receiver)}`));
        }

        const sender = {}; // Specifies the host extension
        const msgId = this.createMsgId();
        const result = new Promise<R>((resolve, reject) => {
            this.requests.set(msgId, { resolve: resolve as (value: unknown) => void, reject });
        });
        const message: RequestMessage = {
            id: msgId,
            method: type.method,
            sender,
            receiver,
            params
        };
        const posted = await view.webview.postMessage(message);
        if (!posted) {
            this.log(`Failed to send message to view: ${participantToString(receiver)}`, 'error');
            this.requests.get(msgId)?.reject(new Error(`Failed to send message to view: ${participantToString(receiver)}`));
            this.requests.delete(msgId);
        }
        return result;
    }

    sendNotification<P extends JsonAny>(type: NotificationType<P>, receiver: MessageParticipant, params: P): void {
        if (receiver.webviewId) {
            const receiverView = this.viewRegistry.get(receiver.webviewId);
            if (receiverView) {
                this.sendNotificationToWebview(type, receiver, params, receiverView)
                    .catch(err => this.log(String(err), 'error'));
            } else {
                this.log(`No webview with id ${receiver.webviewId} is registered.`, 'warn');
            }
        } else if (receiver.webviewType) {
            const receiverViews = this.viewTypeRegistry.get(receiver.webviewType);
            if (receiverViews) {
                receiverViews.forEach(view => {
                    this.sendNotificationToWebview(type, receiver, params, view)
                        .catch(err => this.log(String(err), 'error'));
                });
            } else {
                this.log(`No webview with type ${receiver.webviewType} is registered.`, 'warn');
            }
        } else {
            throw new Error('A notification needs a receiver; neither webviewId nor webviewType was set.');
        }
    }

    protected async sendNotificationToWebview<P extends JsonAny>(type: NotificationType<P>, receiver: MessageParticipant, params: P, view: ViewContainer): Promise<void> {
        if (!view.visible && this.options.ignoreHiddenViews) {
            this.log(`Skipped notification for hidden view: ${participantToString(receiver)}`, 'warn');
            return;
        }

        const message: NotificationMessage = {
            method: type.method,
            sender: {}, // Specifies the host extension
            receiver,
            params
        };
        const result = await view.webview.postMessage(message);
        if (!result) {
            this.log(`Failed to send message to view: ${participantToString(receiver)}`, 'error');
        }
    }

    private nextMsgId = 0;

    protected createMsgId(): string {
        return 'req_' + this.nextMsgId++;
    }

    protected log(text: string, level: 'debug' | 'warn' | 'error' = 'debug'): void {
        switch (level) {
            case 'debug': {
                if (this.options.debugLog) {
                    console.debug(text);
                }
                break;
            }
            case 'warn': {
                console.warn(text);
                break;
            }
            case 'error': {
                console.error(text);
                break;
            }
        }
    }
}

export type ViewContainer = vscode.WebviewPanel | vscode.WebviewView

export interface MessengerOptions {
    /** A message is ignored if the receiver is a webview that is currently hidden (not visible). */
    ignoreHiddenViews?: boolean;
    /** Whether to log any debug-level messages to the console. */
    debugLog?: boolean;
}

export interface RequestData {
    resolve: (value: unknown) => void,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    reject: (reason?: any) => void
}

class IdProvider {

    private counter = 0;

    /**
     * Provide an identifier for the given webview. This should be called only once per webview
     * instance because the result will be different for every call.
     */
    getWebviewId(view: ViewContainer): string {
        return view.viewType + '_' + this.counter++;
    }
}

function participantToString(participant: MessageParticipant): string {
    if (participant.webviewId) {
        return participant.webviewId;
    } else if (participant.webviewType) {
        return participant.webviewType;
    } else {
        return 'host extension';
    }
}
