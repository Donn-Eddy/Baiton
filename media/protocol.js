// @ts-check
/*
 * Browser-loadable form of the webview message protocol reducer (Requirements
 * 9.9, 19.4). The source of truth is `src/orchestrator/webviewProtocol.ts`, the
 * host-free, unit-tested core; this file is its plain-script mirror so the
 * webview can fold host→webview messages into `WebviewState` with the exact
 * same pure `reduce` the tests cover. The entry script renders the view as a
 * projection of the state this reducer produces.
 *
 * Exposes `window.baitonProtocol = { reduce, initialWebviewState }`.
 */
(function () {
  'use strict';

  /** A fresh, empty webview state, useful as a reducer seed. */
  function initialWebviewState() {
    return {
      conversations: [],
      activeId: '',
      sessions: [],
      activeSessionId: '',
      records: [],
      busy: false,
    };
  }

  /**
   * Apply one host→webview message to the state and return the next state.
   * Pure: never mutates its input, never touches a host API. Mirrors the
   * TypeScript `reduce` exactly.
   */
  function reduce(state, msg) {
    switch (msg.type) {
      case 'renderConversation':
        return Object.assign({}, state, { records: msg.records.slice(), empty: undefined });
      case 'appendMessage': {
        const last = state.records[state.records.length - 1];
        if (last !== undefined && last.streaming === true) {
          const head = state.records.slice(0, -1);
          const records =
            msg.record.role === 'assistant'
              ? head.concat([msg.record])
              : head.concat([Object.assign({}, last, { streaming: false }), msg.record]);
          return Object.assign({}, state, { records: records, empty: undefined });
        }
        return Object.assign({}, state, {
          records: state.records.concat([msg.record]),
          empty: undefined,
        });
      }
      case 'streamDelta': {
        const last = state.records[state.records.length - 1];
        if (last !== undefined && last.streaming === true) {
          const grown = Object.assign({}, last, { content: last.content + msg.text });
          return Object.assign({}, state, {
            records: state.records.slice(0, -1).concat([grown]),
            empty: undefined,
          });
        }
        const started = { role: 'assistant', content: msg.text, streaming: true };
        return Object.assign({}, state, {
          records: state.records.concat([started]),
          empty: undefined,
        });
      }
      case 'streamEnd': {
        const last = state.records[state.records.length - 1];
        if (last === undefined || last.streaming !== true) {
          return state;
        }
        const done = Object.assign({}, last, { streaming: false });
        return Object.assign({}, state, { records: state.records.slice(0, -1).concat([done]) });
      }
      case 'updateTool': {
        let found = false;
        const records = state.records.map(function (record) {
          if (found || !record.tool || record.tool.id !== msg.callId) {
            return record;
          }
          found = true;
          return Object.assign({}, record, {
            content: msg.content,
            tool: Object.assign({}, record.tool, { result: msg.result }),
          });
        });
        return found ? Object.assign({}, state, { records: records }) : state;
      }
      case 'setConversations':
        return Object.assign({}, state, { conversations: msg.items.slice() });
      case 'setActive':
        return Object.assign({}, state, { activeId: msg.conversationId });
      case 'setSessions':
        return Object.assign({}, state, { sessions: msg.items.slice() });
      case 'setActiveSession':
        return Object.assign({}, state, { activeSessionId: msg.sessionId });
      case 'showError':
        return Object.assign({}, state, { error: { message: msg.message, action: msg.action } });
      case 'setBusy':
        return Object.assign({}, state, { busy: msg.busy });
      case 'setEmptyState':
        return Object.assign({}, state, { empty: { endpoint: msg.endpoint, model: msg.model } });
      default:
        // Unknown message: leave the state unchanged rather than throwing in the
        // webview. The typed union in the TypeScript source guards this at the
        // host boundary.
        return state;
    }
  }

  window.baitonProtocol = { reduce: reduce, initialWebviewState: initialWebviewState };
})();
