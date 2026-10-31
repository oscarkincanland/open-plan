import React from "react";
import { isStaleChunkError, recoverFromStaleChunk } from "../分包恢复.js";

/**
 * 源码视图局部错误边界：
 * CodeMirror 语言包是懒加载 chunk；构建后旧页面打开源码时可能 404。
 * 这里把失败限制在预览区，不把整个应用打到 AppErrorBoundary。
 */
export default class CodeViewerBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error("[code-viewer]", error, info);
    if (isStaleChunkError(error)) recoverFromStaleChunk(error?.message);
  }

  render() {
    if (!this.state.error) return this.props.children;
    const message = this.state.error?.message || "未知错误";
    return (
      <div className="code-viewer-error" role="alert">
        <strong>源码视图加载失败</strong>
        <span>{message}</span>
        <div className="code-viewer-error-actions">
          <button type="button" className="btn-xs" onClick={() => { this.setState({ error: null }); this.props.onRetry?.(); }}>重新加载</button>
          {this.props.onOpenExternal && <button type="button" className="btn-xs" onClick={() => this.props.onOpenExternal?.()}>用系统应用打开</button>}
        </div>
      </div>
    );
  }
}
