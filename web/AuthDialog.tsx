import React, { useEffect, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { ArrowLeft, ArrowRight, KeyRound, LoaderCircle, X } from 'lucide-react';

type Props = {
  initialMode: 'login' | 'password';
  configured: boolean;
  api: (path: string, options?: RequestInit) => Promise<unknown>;
  onClose: () => void;
  onLogin: () => Promise<void>;
  onPasswordChanged: () => void;
};

export function AuthDialog({initialMode, configured, api, onClose, onLogin, onPasswordChanged}: Props) {
  const [mode, setMode] = useState(initialMode);
  const [password, setPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [busy, setBusy] = useState(false);
  const passwordField = useRef<HTMLInputElement>(null);
  const changing = mode === 'password';
  useEffect(() => { passwordField.current?.focus(); }, [mode]);

  function switchMode(next: 'login' | 'password') {
    setPassword(''); setNewPassword(''); setConfirmation('');
    setError(''); setSuccess(''); setMode(next);
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setError(''); setSuccess('');
    if (changing) {
      if (newPassword.length < 6) { setError('新密码至少需要 6 个字符。'); return; }
      if (newPassword !== confirmation) { setError('两次输入的新密码不一致。'); return; }
      if (newPassword === password) { setError('新密码不能与当前密码相同。'); return; }
    }
    setBusy(true);
    try {
      if (changing) {
        await api('/password', {method: 'POST', body: JSON.stringify({
          current_password: password, new_password: newPassword, confirm_password: confirmation,
        })});
        onPasswordChanged();
        switchMode('login');
        setSuccess('密码已修改，所有旧登录已退出。请使用新密码登录。');
      } else {
        await api('/session', {method: 'POST', body: JSON.stringify({password})});
        setPassword('');
        await onLogin();
        onClose();
      }
    } catch (error) {
      setError(error instanceof Error ? error.message : '请求失败，请重试。');
    } finally { setBusy(false); }
  }

  return <Dialog.Root open onOpenChange={open => { if (!open && !busy) onClose(); }}>
    <Dialog.Portal>
      <Dialog.Overlay className="dialog-overlay"/>
      <Dialog.Content className="dialog auth-dialog" aria-busy={busy}>
        {changing && <div className="auth-eyebrow"><KeyRound size={14}/>WORKSPACE SECURITY</div>}
        <Dialog.Title>{changing ? '修改工作台密码' : '打开你的工作台'}</Dialog.Title>
        <Dialog.Description>{changing
          ? '验证当前密码后设置新密码。仅修改本工作台的访问密码，不涉及 IBKR 账户密码。'
          : '输入本服务的访问密码。这里不接收 IBKR 账户密码。'}</Dialog.Description>
        <form onSubmit={submit}>
          <fieldset disabled={busy}>
            <label className="field-label" htmlFor="desk-password">{changing ? '当前工作台密码' : '工作台密码'}</label>
            <input ref={passwordField} autoComplete="current-password" id="desk-password" type="password" value={password}
              onChange={e => setPassword(e.target.value)} required maxLength={512} className="price-field"/>
            {changing && <>
              <label className="field-label" htmlFor="desk-new-password">新密码 <span>至少 6 个字符</span></label>
              <input autoComplete="new-password" id="desk-new-password" type="password" value={newPassword}
                onChange={e => setNewPassword(e.target.value)} required minLength={6} maxLength={512} className="price-field"/>
              <label className="field-label" htmlFor="desk-confirm-password">确认新密码</label>
              <input autoComplete="new-password" id="desk-confirm-password" type="password" value={confirmation}
                onChange={e => setConfirmation(e.target.value)} required minLength={6} maxLength={512} className="price-field"/>
              <p className="auth-hint">修改后，所有已登录的浏览器都需要重新登录。</p>
            </>}
            {!configured && <p className="inline-warning">请先在项目的私有 .env 文件中设置 DESK_PASSWORD。</p>}
            {error && <p className="inline-warning" role="alert">{error}</p>}
            {success && <p className="auth-success" role="status">{success}</p>}
            <button className="primary" disabled={busy || !configured} type="submit">
              {busy ? (changing ? '正在保存…' : '正在登录…') : (changing ? '保存新密码' : '登录工作台')}
              {busy ? <LoaderCircle className="spin" size={15}/> : <ArrowRight size={15}/>}
            </button>
          </fieldset>
        </form>
        <div className="auth-switch">
          <button type="button" disabled={busy} onClick={() => switchMode(changing ? 'login' : 'password')}>
            {changing ? <ArrowLeft size={13}/> : <KeyRound size={13}/>}
            {changing ? '返回登录' : '修改工作台密码'}
          </button>
          {!changing && <span>需验证当前密码</span>}
        </div>
        <Dialog.Close className="dialog-close" disabled={busy} aria-label="关闭"><X size={17}/></Dialog.Close>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}
