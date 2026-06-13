// ---------------------------------------------------------------------------
// ErrorBanner — actionable error message with retry button
// ---------------------------------------------------------------------------

interface ErrorWithCode extends Error {
  code?: string;
}

interface ErrorBannerProps {
  error: Error;
  onRetry?: () => void;
}

// ---------------------------------------------------------------------------
// Error type detection helpers
// ---------------------------------------------------------------------------

interface ErrorDisplayInfo {
  /** Primary heading shown to the user */
  title: string;
  /** One or more suggested actions the user can take */
  suggestions: string[];
}

function classifyError(error: Error): ErrorDisplayInfo {
  const code = (error as ErrorWithCode).code;
  const message = error.message || '';

  // ── API error codes ──

  if (code === 'NOT_FOUND') {
    return {
      title: '未找到请求的资源',
      suggestions: [
        '确认 Run ID 或项目名称是否正确',
        '该资源可能已被清理或归档',
        '返回列表页重新选择',
      ],
    };
  }

  if (code === 'UNAUTHORIZED') {
    return {
      title: '认证失败，无法访问',
      suggestions: [
        'Token 可能已过期或无效',
        '请刷新页面重新登录',
        '如果问题持续，联系管理员重新生成 Token',
      ],
    };
  }

  if (code === 'BAD_REQUEST') {
    return {
      title: '请求参数有误',
      suggestions: [
        '请检查输入内容是否符合格式要求',
        '确认必填字段是否已填写',
        '刷新页面后重试',
      ],
    };
  }

  if (code === 'INTERNAL_ERROR') {
    return {
      title: '服务内部错误',
      suggestions: [
        '稍等片刻后重试，这通常是临时性问题',
        '如果反复出现，请检查服务端日志',
        '可尝试刷新页面或重新发起操作',
      ],
    };
  }

  if (code === 'PARSE_ERROR') {
    return {
      title: '数据解析失败',
      suggestions: [
        '服务端返回的数据格式异常',
        '请刷新页面重新加载',
        '如果问题持续，联系管理员检查服务状态',
      ],
    };
  }

  // ── Network / connectivity errors ──

  if (
    error.name === 'TypeError' &&
    (message.includes('fetch') || message.includes('network') || message.includes('NetworkError'))
  ) {
    return {
      title: '网络连接异常',
      suggestions: [
        '请检查网络连接是否正常',
        '确认服务端是否正在运行',
        '尝试刷新页面或稍后重试',
      ],
    };
  }

  if (
    error.name === 'AbortError' ||
    message.includes('abort') ||
    message.includes('signal')
  ) {
    return {
      title: '请求已被取消',
      suggestions: [
        '请求因超时或页面切换被取消',
        '请重新执行操作',
      ],
    };
  }

  // ── Timeout ──

  if (
    error.name === 'TimeoutError' ||
    message.includes('timeout') ||
    message.includes('超时')
  ) {
    return {
      title: '请求超时',
      suggestions: [
        '服务端响应时间过长',
        '稍等片刻后重试',
        '如果持续超时，请检查服务端负载',
      ],
    };
  }

  // ── Generic / unknown ──

  return {
    title: '操作未成功',
    suggestions: [
      '请稍后重试',
      '如果问题反复出现，请检查操作日志了解详情',
      '可尝试刷新页面后重新操作',
    ],
  };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ErrorBanner({ error, onRetry }: ErrorBannerProps) {
  const info = classifyError(error);

  return (
    <div
      style={{
        padding: '16px 20px',
        background: 'var(--fail-bg)',
        border: '1px solid #fecaca',
        borderRadius: 'var(--r-md)',
        marginBottom: '16px',
      }}
    >
      {/* Header row: title + retry */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '12px',
        }}
      >
        <div style={{ fontWeight: 600, color: 'var(--fail)', fontSize: '13px' }}>
          {info.title}
        </div>
        {onRetry !== undefined ? (
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={onRetry}
          >
            ↻ 重试
          </button>
        ) : null}
      </div>

      {/* Error detail (technical, collapsed by default via tooltip) */}
      <div
        style={{ color: 'var(--text-s)', fontSize: '12px', marginTop: '6px' }}
        title={error.message}
      >
        {error.message}
      </div>

      {/* Suggested actions */}
      {info.suggestions.length > 0 && (
        <div style={{ marginTop: '10px' }}>
          <div
            style={{
              fontSize: '11px',
              fontWeight: 600,
              color: 'var(--text-t)',
              textTransform: 'uppercase',
              letterSpacing: '0.04em',
              marginBottom: '4px',
            }}
          >
            建议操作
          </div>
          <ul
            style={{
              margin: 0,
              paddingLeft: '16px',
              fontSize: '12px',
              color: 'var(--text-s)',
              lineHeight: '1.6',
            }}
          >
            {info.suggestions.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
