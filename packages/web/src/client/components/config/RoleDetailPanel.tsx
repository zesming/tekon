import { useEffect, useState } from 'react';

import { useDialogA11y } from '../../hooks/use-dialog-a11y.js';
import { useFlash } from '../../context/flash-context.js';
import { useSessionToken } from '../../hooks/use-session-token.js';
import { useMutation, useQuery } from '../../hooks/index.js';
import { rpc } from '../../lib/rpc-client.js';
import { queryKeys } from '../../lib/query-keys.js';
import type {
  ApiRoleItem,
  RoleGetOutput,
  RoleUpdatePromptInput,
  RoleUpdatePromptOutput,
} from '../../../shared/api-types.js';
import type { RpcProcedureMap } from '../../../shared/rpc-contract.js';
import { LoadingState } from '../ui/LoadingState.js';
import { ErrorBanner } from '../ui/ErrorBanner.js';

// ---------------------------------------------------------------------------
// RoleDetailPanel — slide-in side panel showing the effective prompt and
// allowing project-level prompt edits (PD-11).
//
// Built-in role prompts live in the public Tekon package and project role
// files on the user's own machine, so displaying them is not a secret leak.
// Saving a built-in role creates a whole-folder project override instead of
// modifying the installation directory.
// ---------------------------------------------------------------------------

interface RoleDetailPanelProps {
  role: ApiRoleItem;
  onClose: () => void;
}

export function RoleDetailPanel({ role, onClose }: RoleDetailPanelProps) {
  const panelRef = useDialogA11y<HTMLDivElement>({ onClose });
  const titleId = `role-detail-title-${role.id}`;
  const { addFlash } = useFlash();
  const { token } = useSessionToken();
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState('');

  const query = useQuery<RoleGetOutput>(queryKeys.roleDetail(role.id), () =>
    rpc.call('role.get', { id: role.id }),
  );

  const saveMutation = useMutation<
    RpcProcedureMap['role.updatePrompt']['input'],
    RpcProcedureMap['role.updatePrompt']['output']
  >((input) => rpc.call('role.updatePrompt', input), {
    invalidateKeys: [queryKeys.roleDetail(role.id), queryKeys.roles()],
  });

  // 每次拿到最新详情时重置草稿，避免残留上一次编辑内容。
  useEffect(() => {
    if (query.data) {
      setDraft(query.data.systemPrompt);
    }
  }, [query.data]);

  const startEditing = () => {
    if (!token) {
      addFlash('warning', '请先设置会话令牌');
      return;
    }
    setDraft(query.data?.systemPrompt ?? '');
    setIsEditing(true);
  };

  const handleSave = async () => {
    if (!token) {
      addFlash('warning', '请先设置会话令牌');
      return;
    }
    if (draft.trim().length === 0) {
      addFlash('error', '角色 prompt 不能为空');
      return;
    }
    try {
      const input: RoleUpdatePromptInput = {
        id: role.id,
        systemPrompt: draft,
        token,
      };
      const result: RoleUpdatePromptOutput = await saveMutation.mutate(input);
      addFlash('success', `已保存项目级角色覆盖：${result.roleDir}`);
      setIsEditing(false);
    } catch (error) {
      addFlash(
        'error',
        error instanceof Error ? error.message : '角色 prompt 保存失败',
      );
    }
  };

  const detail = query.data;

  return (
    <div
      className="detail-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        className="detail-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        {/* ── Header ── */}
        <div className="detail-panel-header">
          <div>
            <div
              id={titleId}
              style={{
                fontFamily: 'var(--font-d)',
                fontSize: '20px',
                fontWeight: 600,
              }}
            >
              {role.name}
            </div>
            <div className="text-sm text-muted" style={{ marginTop: '2px' }}>
              {role.id}
            </div>
          </div>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            aria-label="关闭角色详情"
            onClick={onClose}
          >
            ✕
          </button>
        </div>

        {/* ── Body ── */}
        <div className="detail-panel-body">
          {/* Properties */}
          <div className="detail-section">
            <div className="detail-section-title">属性 Properties</div>
            <dl className="detail-kv">
              <dt>ID</dt>
              <dd className="text-mono">{role.id}</dd>
              <dt>Name</dt>
              <dd>{role.name}</dd>
              <dt>Source</dt>
              <dd>
                <span className="source-badge">
                  {role.source === 'project' ? '项目 project' : '内置 built-in'}
                </span>
              </dd>
              <dt>项目覆盖路径</dt>
              <dd className="text-mono">
                {detail?.projectPath ?? '.tekon/roles/…'}
              </dd>
            </dl>
          </div>

          {/* Built-in override notice */}
          {detail &&
            detail.source === 'built-in' &&
            !detail.hasProjectOverride && (
              <div
                className="detail-section"
                style={{
                  padding: '12px 16px',
                  background: 'var(--soft)',
                  borderRadius: 'var(--r-sm)',
                  border: '1px solid var(--line)',
                }}
              >
                <div
                  style={{
                    fontSize: '12px',
                    color: 'var(--text-s)',
                    lineHeight: 1.7,
                  }}
                >
                  该角色来自 Tekon 内置目录。保存编辑会在
                  <code> .tekon/roles/{role.id}/ </code>
                  创建项目级覆盖（复制完整角色目录），不会修改安装文件；运行时项目覆盖优先于内置。
                </div>
              </div>
            )}

          {/* Prompt */}
          <div className="detail-section">
            <div className="detail-section-title">系统提示词 System Prompt</div>
            {query.isLoading ? (
              <LoadingState message="Loading prompt..." />
            ) : query.error ? (
              <ErrorBanner error={query.error} onRetry={query.refetch} />
            ) : (
              <>
                <textarea
                  className="textarea"
                  value={isEditing ? draft : (detail?.systemPrompt ?? '')}
                  readOnly={!isEditing}
                  onChange={(event) => setDraft(event.target.value)}
                  rows={16}
                  aria-label={`${role.id} 系统提示词`}
                  style={{
                    width: '100%',
                    fontFamily: 'var(--font-m)',
                    fontSize: '12px',
                    lineHeight: 1.7,
                  }}
                />
                <div
                  style={{
                    display: 'flex',
                    gap: '8px',
                    marginTop: '12px',
                    justifyContent: 'flex-end',
                  }}
                >
                  {isEditing ? (
                    <>
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        onClick={() => {
                          setIsEditing(false);
                          setDraft(detail?.systemPrompt ?? '');
                        }}
                        disabled={saveMutation.isPending}
                      >
                        取消
                      </button>
                      <button
                        type="button"
                        className="btn btn-primary btn-sm"
                        onClick={handleSave}
                        disabled={saveMutation.isPending}
                      >
                        {saveMutation.isPending ? '保存中…' : '保存覆盖'}
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      onClick={startEditing}
                    >
                      编辑 prompt
                    </button>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
