import React, { useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  ArrowLeft,
  Camera,
  CheckCircle,
  Clock,
  Copy,
  CreditCard,
  Eye,
  EyeOff,
  KeyRound,
  Laptop,
  Loader2,
  Lock,
  LogOut,
  MonitorSmartphone,
  Save,
  Shield,
  Trash2,
  User,
  X,
} from 'lucide-react';
import { formatCountLimit, formatStorageLimit, formatUsageMetric, getTierLimits, resolveTier } from '@hollowbits/core';
import { supabase } from '../../services/supabase';
import { projectOsService, type UsageSummary } from '../../services/projectOsService';
import { useAuthStore } from '../../stores/authStore';
import { formatSessionDate, loadActiveSessions, maskSessionIp, normalizeUserAgent, revokeRemoteSession, type ActiveSession } from '../../services/sessionControl';

type FeedbackStatus = 'idle' | 'saving' | 'success' | 'error';

interface DesktopSettingsProps {
  onBack: () => void;
}

export function DesktopSettings({ onBack }: DesktopSettingsProps) {
  const { user, session, profile, signOut, refreshProfile } = useAuthStore();
  const [fullName, setFullName] = useState('');
  const [username, setUsername] = useState('');
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [profileStatus, setProfileStatus] = useState<FeedbackStatus>('idle');
  const [profileMessage, setProfileMessage] = useState('');
  const avatarInputRef = useRef<HTMLInputElement>(null);

  const [license, setLicense] = useState<any>(null);
  const [sessions, setSessions] = useState<ActiveSession[]>([]);
  const [sessionMessage, setSessionMessage] = useState('');
  const [sessionBusy, setSessionBusy] = useState<string | null>(null);
  const [usageSummary, setUsageSummary] = useState<UsageSummary | null>(null);
  const [loadingExtra, setLoadingExtra] = useState(false);

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showCurrentPw, setShowCurrentPw] = useState(false);
  const [showNewPw, setShowNewPw] = useState(false);
  const [showConfirmPw, setShowConfirmPw] = useState(false);
  const [passwordStatus, setPasswordStatus] = useState<FeedbackStatus>('idle');
  const [passwordMessage, setPasswordMessage] = useState('');

  const [mfaEnabled, setMfaEnabled] = useState(false);
  const [mfaLoading, setMfaLoading] = useState(false);
  const [mfaQr, setMfaQr] = useState<string | null>(null);
  const [mfaSecret, setMfaSecret] = useState<string | null>(null);
  const [mfaFactorId, setMfaFactorId] = useState<string | null>(null);
  const [mfaCode, setMfaCode] = useState('');
  const [mfaMessage, setMfaMessage] = useState('');
  const [copied, setCopied] = useState(false);
  const [timeLeft, setTimeLeft] = useState(30);

  const authProvider = user?.app_metadata?.provider || 'email';
  const isOAuthUser = authProvider !== 'email';
  const emailAddress = user?.email || '';
  const createdAt = user?.created_at ? new Date(user.created_at).toLocaleDateString('es-MX') : '-';

  useEffect(() => {
    if (!profile) return;
    setFullName(profile.full_name || '');
    setUsername(profile.username || '');
    setAvatarUrl(profile.avatar_url || null);
  }, [profile]);

  useEffect(() => {
    const update = () => {
      const epoch = Math.floor(Date.now() / 1000);
      setTimeLeft(30 - (epoch % 30));
    };
    update();
    const interval = window.setInterval(update, 1000);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    const loadMfa = async () => {
      try {
        const { data } = await supabase.auth.mfa.listFactors();
        const verified = data?.totp?.find((factor) => factor.status === 'verified');
        if (verified) {
          setMfaEnabled(true);
          setMfaFactorId(verified.id);
        }
      } catch (error) {
        console.error('[DesktopSettings] MFA status failed:', error);
      }
    };
    void loadMfa();
  }, []);

  useEffect(() => {
    if (!user) return;

    const fetchExtraData = async () => {
      setLoadingExtra(true);
      try {
        try {
          setSessions(await loadActiveSessions(session));
          setSessionMessage('');
        } catch (sessionError) {
          console.error('[DesktopSettings] Sessions failed:', sessionError);
          setSessionMessage('No se pudieron consultar las sesiones en este momento.');
        }

        const { data: licenseData } = await supabase
          .from('licenses')
          .select('*')
          .eq('user_id', user.id)
          .single();
        if (licenseData) setLicense(licenseData);

        const usageData = await projectOsService.getUsageSummary().catch((error) => {
          console.warn('[DesktopSettings] Project OS usage failed:', error);
          return null;
        });
        if (usageData) setUsageSummary(usageData);
      } catch (error) {
        console.error('[DesktopSettings] Extra data failed:', error);
      } finally {
        setLoadingExtra(false);
      }
    };

    void fetchExtraData();
  }, [user, session]);

  useEffect(() => {
    if (!user || !session) return;
    const interval = window.setInterval(() => {
      void loadActiveSessions(session).then(setSessions).catch(() => undefined);
    }, 30_000);
    return () => window.clearInterval(interval);
  }, [user, session]);

  const handleSaveProfile = async () => {
    if (!user) return;
    setProfileStatus('saving');
    setProfileMessage('');

    try {
      const trimmedUsername = username.trim().toLowerCase().replace(/\s+/g, '_');
      const { error } = await supabase
        .from('profiles')
        .update({
          full_name: fullName.trim(),
          username: trimmedUsername,
          avatar_url: avatarUrl,
          updated_at: new Date().toISOString(),
        })
        .eq('id', user.id);

      if (error) {
        setProfileStatus('error');
        setProfileMessage(error.message.includes('duplicate') ? 'Ese usuario ya esta en uso.' : error.message);
        return;
      }

      setProfileStatus('success');
      setProfileMessage('Perfil actualizado correctamente.');
      await refreshProfile();
      window.setTimeout(() => setProfileStatus('idle'), 2500);
    } catch (error: any) {
      setProfileStatus('error');
      setProfileMessage(error?.message || 'Error inesperado al guardar perfil.');
    }
  };

  const handleAvatarUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file || !user) return;

    try {
      const fileExt = file.name.split('.').pop();
      const filePath = `${user.id}/avatar.${fileExt}`;
      const { error } = await supabase.storage.from('avatars').upload(filePath, file, { upsert: true });
      if (error) throw error;

      const { data } = supabase.storage.from('avatars').getPublicUrl(filePath);
      setAvatarUrl(data.publicUrl);
      setProfileStatus('idle');
      setProfileMessage('Imagen cargada. Guarda cambios para aplicar.');
    } catch (error: any) {
      setProfileStatus('error');
      setProfileMessage(error?.message || 'Error al subir imagen.');
    } finally {
      if (avatarInputRef.current) avatarInputRef.current.value = '';
    }
  };

  const handlePasswordChange = async () => {
    setPasswordMessage('');

    if (!isOAuthUser && !currentPassword) {
      setPasswordStatus('error');
      setPasswordMessage('Ingresa tu contrasena actual.');
      return;
    }

    if (newPassword.length < 6) {
      setPasswordStatus('error');
      setPasswordMessage('La nueva contrasena debe tener al menos 6 caracteres.');
      return;
    }

    if (newPassword !== confirmPassword) {
      setPasswordStatus('error');
      setPasswordMessage('Las contrasenas nuevas no coinciden.');
      return;
    }

    setPasswordStatus('saving');
    try {
      if (!isOAuthUser && emailAddress) {
        const { error } = await supabase.auth.signInWithPassword({
          email: emailAddress,
          password: currentPassword,
        });
        if (error) {
          setPasswordStatus('error');
          setPasswordMessage('La contrasena actual es incorrecta.');
          return;
        }
      }

      const { error } = await supabase.auth.updateUser({ password: newPassword });
      if (error) {
        setPasswordStatus('error');
        setPasswordMessage(error.message);
        return;
      }

      setPasswordStatus('success');
      setPasswordMessage(isOAuthUser
        ? 'Contrasena establecida correctamente.'
        : 'Contrasena actualizada correctamente.');
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      window.setTimeout(() => setPasswordStatus('idle'), 3000);
    } catch (error: any) {
      setPasswordStatus('error');
      setPasswordMessage(error?.message || 'Error inesperado al cambiar contrasena.');
    }
  };

  const handleEnrollMfa = async () => {
    setMfaLoading(true);
    setMfaMessage('');
    try {
      const { data: factorsData } = await supabase.auth.mfa.listFactors();
      for (const factor of factorsData?.totp || []) {
        const factorStatus = String((factor as { status?: string }).status || '');
        if (factorStatus === 'unverified') {
          await supabase.auth.mfa.unenroll({ factorId: factor.id });
        }
      }

      const { data, error } = await supabase.auth.mfa.enroll({
        factorType: 'totp',
        friendlyName: 'DAW-fi Desktop',
      });
      if (error || !data) {
        setMfaMessage(error?.message || 'Error al activar 2FA.');
        return;
      }

      setMfaQr(data.totp.qr_code);
      setMfaSecret(data.totp.secret);
      setMfaFactorId(data.id);
    } catch (error: any) {
      setMfaMessage(error?.message || 'Error inesperado al configurar 2FA.');
    } finally {
      setMfaLoading(false);
    }
  };

  const handleVerifyMfa = async () => {
    if (!mfaFactorId) return;
    setMfaLoading(true);
    setMfaMessage('');

    try {
      const { error } = await supabase.auth.mfa.challengeAndVerify({
        factorId: mfaFactorId,
        code: mfaCode.trim(),
      });
      if (error) {
        setMfaMessage('Codigo invalido. Intenta de nuevo.');
        return;
      }

      setMfaEnabled(true);
      setMfaQr(null);
      setMfaSecret(null);
      setMfaCode('');
      setMfaMessage('2FA activado correctamente.');
    } catch (error: any) {
      setMfaMessage(error?.message || 'Error inesperado al verificar codigo.');
    } finally {
      setMfaLoading(false);
    }
  };

  const handleUnenrollMfa = async () => {
    if (!mfaFactorId) return;
    setMfaLoading(true);
    try {
      const { error } = await supabase.auth.mfa.unenroll({ factorId: mfaFactorId });
      if (error) {
        setMfaMessage(error.message);
        return;
      }
      setMfaEnabled(false);
      setMfaFactorId(null);
      setMfaMessage('2FA desactivado.');
    } finally {
      setMfaLoading(false);
    }
  };

  const handleCancelMfa = () => {
    if (mfaFactorId) {
      supabase.auth.mfa.unenroll({ factorId: mfaFactorId }).catch(() => undefined);
    }
    setMfaQr(null);
    setMfaSecret(null);
    setMfaFactorId(null);
    setMfaCode('');
    setMfaMessage('');
  };

  const handleCopySecret = async () => {
    if (!mfaSecret) return;
    await navigator.clipboard.writeText(mfaSecret);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  };

  const handleRevokeSession = async (sessionId: string) => {
    const target = sessions.find((item) => item.id === sessionId);
    if (!target || target.is_current) {
      setSessionMessage('La sesión de este dispositivo se cierra desde “Cerrar sesión”.');
      return;
    }
    if (!window.confirm('¿Revocar el acceso de este dispositivo?')) return;
    setSessionBusy(sessionId);
    try {
      const result = await revokeRemoteSession(sessionId);
      if (!result.revoked) throw new Error(result.reason || 'La sesión ya no está activa.');
      setSessions(await loadActiveSessions(session));
      setSessionMessage('Acceso revocado. El cambio se reflejará cuando ese dispositivo renueve su sesión.');
    } catch (error) {
      console.error('[DesktopSettings] Revoke session failed:', error);
      setSessionMessage('No se pudo revocar el dispositivo. Intenta de nuevo.');
    } finally {
      setSessionBusy(null);
    }
  };

  const handleSignOutOthers = async () => {
    if (!window.confirm('Se cerrarán las demás sesiones activas. ¿Continuar?')) return;
    setSessionBusy('others');
    try {
      const { error } = await supabase.auth.signOut({ scope: 'others' });
      if (error) throw error;
      setSessions(await loadActiveSessions(session));
      setSessionMessage('Las demás sesiones fueron cerradas.');
    } catch (error) {
      console.error('[DesktopSettings] Sign out others failed:', error);
      setSessionMessage('No se pudieron cerrar las demás sesiones.');
    } finally {
      setSessionBusy(null);
    }
  };

  const avatarDisplay = avatarUrl
    || `https://ui-avatars.com/api/?name=${encodeURIComponent(fullName || 'U')}&background=8b7cf6&color=fff&size=128&bold=true`;
  const currentTier = resolveTier(license?.tier || profile?.tier);
  const tierLimits = getTierLimits(currentTier);
  const measuredUsage = usageSummary || {
    storage_bytes: 0,
    ai_action: 0,
    render_minutes: 0,
    sample_claim: 0,
    collaborator_seat: 0,
    snapshot: 0,
  };
  const usageRows = [
    { label: 'Storage cloud', value: `${formatUsageMetric('storage_bytes', measuredUsage.storage_bytes)} / ${formatStorageLimit(tierLimits.storageBytes)}` },
    { label: 'Snapshots cloud', value: `${formatUsageMetric('snapshot', measuredUsage.snapshot)} / ${tierLimits.snapshotRetentionDays === 0 ? 'Solo local' : tierLimits.snapshotRetentionDays === -1 ? 'Ilimitado' : `${tierLimits.snapshotRetentionDays} dias`}` },
    { label: 'Render cloud', value: `${formatUsageMetric('render_minutes', measuredUsage.render_minutes)} / ${tierLimits.renderMinutesPerMonth === 0 ? 'No incluido' : formatCountLimit(tierLimits.renderMinutesPerMonth, ' min/mes')}` },
    { label: 'AI actions', value: `${formatUsageMetric('ai_action', measuredUsage.ai_action)} / ${formatCountLimit(tierLimits.aiRequestsPerMonth, '/mes')}` },
  ];

  return (
    <div className="desktop-settings">
      <button className="desktop-btn" onClick={onBack}>
        <ArrowLeft size={15} /> Volver al hub
      </button>

      <div style={{ marginTop: 28 }}>
        <h1>Configuracion de la cuenta</h1>
        <p className="desktop-kicker">Administra perfil, seguridad y preferencias del ecosistema.</p>
      </div>

      <section className="desktop-settings__section">
        <div className="desktop-settings__label"><User size={14} /> Perfil de operador</div>
        <div className="desktop-panel">
          <div className="desktop-row" style={{ alignItems: 'flex-start', marginBottom: 20 }}>
            <div className="desktop-profile">
              <button className="desktop-avatar" onClick={() => avatarInputRef.current?.click()} title="Cambiar avatar">
                <img src={avatarDisplay} alt="Avatar" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
              </button>
              <div>
                <h3>{fullName || 'Sin nombre'}</h3>
                <p>{emailAddress}</p>
              </div>
            </div>
            <button className="desktop-btn" onClick={() => avatarInputRef.current?.click()}><Camera size={15} /> Avatar</button>
            <input ref={avatarInputRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={handleAvatarUpload} />
          </div>

          <div className="desktop-fields">
            <label className="desktop-field">
              <span>Nombre completo</span>
              <input className="desktop-input" value={fullName} onChange={(event) => setFullName(event.target.value)} />
            </label>
            <label className="desktop-field">
              <span>Usuario</span>
              <input className="desktop-input" value={username} onChange={(event) => setUsername(event.target.value)} />
            </label>
            <label className="desktop-field">
              <span>Email</span>
              <input className="desktop-input" value={emailAddress} disabled />
            </label>
            <label className="desktop-field">
              <span>Alta</span>
              <input className="desktop-input" value={createdAt} disabled />
            </label>
          </div>

          {profileMessage && (
            <div className={`desktop-feedback ${profileStatus === 'success' ? 'desktop-feedback--success' : ''}`} style={{ marginTop: 16 }}>
              {profileStatus === 'success' ? <CheckCircle size={15} /> : <AlertCircle size={15} />} {profileMessage}
            </div>
          )}

          <button className="desktop-btn desktop-btn--primary" onClick={handleSaveProfile} disabled={profileStatus === 'saving'} style={{ marginTop: 16 }}>
            {profileStatus === 'saving' ? <Loader2 size={15} /> : <Save size={15} />} Guardar cambios
          </button>
        </div>
      </section>

      <section className="desktop-settings__section">
        <div className="desktop-settings__label"><CreditCard size={14} /> Licencia y suscripcion</div>
        <div className="desktop-panel">
          <h3>Plan actual</h3>
          {loadingExtra ? (
            <p><Loader2 size={14} /> Cargando licencia...</p>
          ) : license ? (
            <div style={{ display: 'grid', gap: 14 }}>
              <div className="desktop-row">
                <div>
                  <h3 style={{ textTransform: 'capitalize' }}>{currentTier === 'free' ? 'Plan Basico' : `Plan ${currentTier}`}</h3>
                  <p>Estado: {license.status}{license.current_period_end ? ` · hasta ${new Date(license.current_period_end).toLocaleDateString()}` : ''}</p>
                </div>
                <span className="desktop-meta">{profile?.tier || license.tier}</span>
              </div>
              <div style={{ display: 'grid', gap: 8 }}>
                {usageRows.map((row) => (
                  <div key={row.label} className="desktop-row" style={{ padding: '10px 0', borderTop: '1px solid rgba(255,255,255,0.06)' }}>
                    <span>{row.label}</span>
                    <span className="desktop-meta">{row.value}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <p>No se encontro informacion de licencia.</p>
          )}
        </div>
      </section>

      <section className="desktop-settings__section">
        <div className="desktop-settings__label"><Lock size={14} /> Seguridad</div>
        <div className="desktop-panel">
          <h3>{isOAuthUser ? 'Establecer contrasena' : 'Cambiar contrasena'}</h3>
          <p>{isOAuthUser ? 'Agrega una contrasena para acceder tambien con correo.' : 'Actualiza la contrasena de acceso al ecosistema.'}</p>
          <div className="desktop-fields">
            {!isOAuthUser && (
              <label className="desktop-field">
                <span>Contrasena actual</span>
                <div className="desktop-row">
                  <input className="desktop-input" type={showCurrentPw ? 'text' : 'password'} value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} />
                  <button className="desktop-btn" onClick={() => setShowCurrentPw((value) => !value)} type="button">{showCurrentPw ? <EyeOff size={14} /> : <Eye size={14} />}</button>
                </div>
              </label>
            )}
            <label className="desktop-field">
              <span>Nueva contrasena</span>
              <div className="desktop-row">
                <input className="desktop-input" type={showNewPw ? 'text' : 'password'} value={newPassword} onChange={(event) => setNewPassword(event.target.value)} />
                <button className="desktop-btn" onClick={() => setShowNewPw((value) => !value)} type="button">{showNewPw ? <EyeOff size={14} /> : <Eye size={14} />}</button>
              </div>
            </label>
            <label className="desktop-field">
              <span>Confirmar contrasena</span>
              <div className="desktop-row">
                <input className="desktop-input" type={showConfirmPw ? 'text' : 'password'} value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} />
                <button className="desktop-btn" onClick={() => setShowConfirmPw((value) => !value)} type="button">{showConfirmPw ? <EyeOff size={14} /> : <Eye size={14} />}</button>
              </div>
            </label>
          </div>
          {passwordMessage && (
            <div className={`desktop-feedback ${passwordStatus === 'success' ? 'desktop-feedback--success' : ''}`} style={{ marginTop: 16 }}>
              {passwordStatus === 'success' ? <CheckCircle size={15} /> : <AlertCircle size={15} />} {passwordMessage}
            </div>
          )}
          <button className="desktop-btn desktop-btn--primary" onClick={handlePasswordChange} disabled={passwordStatus === 'saving' || !newPassword} style={{ marginTop: 16 }}>
            <KeyRound size={15} /> {passwordStatus === 'saving' ? 'Procesando...' : 'Actualizar contrasena'}
          </button>
        </div>

        <div className="desktop-panel">
          <h3><Shield size={18} /> Verificacion en dos pasos</h3>
          <p>Anade una capa extra de seguridad con una app de autenticacion TOTP.</p>
          {mfaEnabled ? (
            <div className="desktop-row">
              <span className="desktop-feedback desktop-feedback--success"><CheckCircle size={15} /> 2FA activo</span>
              <button className="desktop-btn desktop-btn--danger" onClick={handleUnenrollMfa} disabled={mfaLoading}>Desactivar 2FA</button>
            </div>
          ) : mfaQr ? (
            <div style={{ display: 'grid', gap: 16 }}>
              <div className="desktop-row">
                <div style={{ background: '#fff', padding: 14, borderRadius: 8 }}>
                  <img src={mfaQr} alt="MFA QR" style={{ width: 180, height: 180 }} />
                </div>
                <button className="desktop-btn" onClick={handleCancelMfa}><X size={15} /> Cancelar</button>
              </div>
              {mfaSecret && (
                <div className="desktop-row">
                  <code className="desktop-meta">{mfaSecret}</code>
                  <button className="desktop-btn" onClick={handleCopySecret}>{copied ? <CheckCircle size={15} /> : <Copy size={15} />} Copiar</button>
                </div>
              )}
              <span className="desktop-meta"><Clock size={12} /> {timeLeft}s para rotacion</span>
              <input className="desktop-input" value={mfaCode} onChange={(event) => setMfaCode(event.target.value.replace(/\D/g, ''))} maxLength={6} placeholder="000000" style={{ textAlign: 'center', letterSpacing: 8, fontSize: 22 }} />
              <button className="desktop-btn desktop-btn--primary" onClick={handleVerifyMfa} disabled={mfaLoading || mfaCode.length < 6}>Verificar y activar</button>
            </div>
          ) : (
            <button className="desktop-btn desktop-btn--primary" onClick={handleEnrollMfa} disabled={mfaLoading}>
              <Shield size={15} /> {mfaLoading ? 'Configurando...' : 'Activar 2FA'}
            </button>
          )}
          {mfaMessage && <div className={`desktop-feedback ${mfaEnabled ? 'desktop-feedback--success' : ''}`} style={{ marginTop: 16 }}>{mfaMessage}</div>}
        </div>

        <div className="desktop-panel">
          <h3><MonitorSmartphone size={18} /> Dispositivos activos</h3>
          <p>Revisa navegador, IP parcialmente oculta y última actividad. La lista se actualiza automáticamente.</p>
          <button className="desktop-btn" onClick={() => void handleSignOutOthers()} disabled={sessionBusy !== null || sessions.filter((item) => !item.is_current).length === 0} style={{ marginTop: 10 }}>
            {sessionBusy === 'others' ? <Loader2 size={15} /> : <Shield size={15} />} Cerrar otras sesiones
          </button>
          <div style={{ display: 'grid', gap: 10, marginTop: 16 }}>
            {loadingExtra ? (
              <p><Loader2 size={14} /> Cargando sesiones...</p>
            ) : sessions.length === 0 ? (
              <p>No hay sesiones activas adicionales.</p>
            ) : sessions.map((activeSession) => {
              const device = normalizeUserAgent(activeSession.user_agent);
              return <div key={activeSession.id} className="desktop-row desktop-panel" style={{ padding: 14 }}>
                <div className="desktop-row" style={{ justifyContent: 'flex-start' }}>
                  <Laptop size={18} color="var(--desktop-purple)" />
                  <div>
                    <strong>{device.label} {activeSession.is_current ? '· Este dispositivo' : ''}</strong>
                    <p className="desktop-meta">IP: {maskSessionIp(activeSession.ip)} · Alta: {formatSessionDate(activeSession.created_at)} · Última actividad: {formatSessionDate(activeSession.last_active)}</p>
                  </div>
                </div>
                <button className="desktop-btn desktop-btn--danger" onClick={() => void handleRevokeSession(activeSession.id)} disabled={activeSession.is_current || sessionBusy !== null} title={activeSession.is_current ? 'Usa Cerrar sesión para este dispositivo' : 'Revocar sesión'}>{sessionBusy === activeSession.id ? <Loader2 size={15} /> : <Trash2 size={15} />}</button>
              </div>;
            })}
          </div>
          {sessionMessage && <div className="desktop-feedback" style={{ marginTop: 12 }}><AlertCircle size={15} /> {sessionMessage}</div>}
        </div>
      </section>

      <section className="desktop-settings__section">
        <div className="desktop-settings__label"><LogOut size={14} /> Sesion</div>
        <div className="desktop-panel desktop-row">
          <div>
            <h3>Cerrar sesion</h3>
            <p>Cierra tu sesion activa en este dispositivo.</p>
          </div>
          <button className="desktop-btn desktop-btn--danger" onClick={() => signOut()}>
            <LogOut size={15} /> Cerrar sesion
          </button>
        </div>
      </section>
    </div>
  );
}
