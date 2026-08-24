import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  BarChart3,
  Bell,
  Check,
  ChevronRight,
  Cloud,
  CloudOff,
  Copy,
  FolderOpen,
  Gauge,
  Grid3X3,
  HardDrive,
  LayoutDashboard,
  List,
  LogOut,
  MoreVertical,
  Music2,
  Palette,
  Pencil,
  Piano,
  Play,
  Plus,
  RefreshCw,
  Search,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  Upload,
  UserPlus,
  Users,
  X,
  Zap,
} from 'lucide-react';
import AppLogo from '../AppLogo';
import { platformService } from '../../services/platformService';
import { isSupabaseConfigured, supabase } from '../../services/supabase';
import { useAuthStore } from '../../stores/authStore';
import type { Database, Project } from '../../types/supabase';

type HubTab = 'personal' | 'shared' | 'teams';
type HubSection = 'library' | 'teams' | 'activity' | 'personalization';
type HubView = 'grid' | 'list';
type HubDensity = 'comfortable' | 'compact';
type HubAccent = 'violet' | 'cyan' | 'rose' | 'amber';
type ProjectSort = 'updated' | 'name' | 'bpm';
type DesktopProduct = 'studio' | 'score' | 'keys';
type LicenseRecord = Database['public']['Tables']['licenses']['Row'];

interface HubPreferences {
  view: HubView;
  density: HubDensity;
  accent: HubAccent;
}

interface WorkspaceSummary {
  id: string;
  created_by: string;
  category: string | null;
  name?: string | null;
  slug?: string | null;
  role?: string | null;
  joined_at?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

interface DesktopHubProps {
  refreshSignal: number;
  onLogin: () => void;
  onSignup: () => void;
  onSettings: () => void;
}

interface NotificationRecord {
  id: string;
  type: string;
  status: string;
  project_id: string | null;
  team_id: string | null;
  message: string | null;
  created_at: string | null;
  sender_id: string | null;
}

interface ProjectRuntimeStats {
  tracks: number;
  devices: number;
  scenes: number;
  sizeLabel: string;
}

const HUB_PREFS_KEY = 'hollowbits.desktop.hub.preferences';
const DEFAULT_PREFERENCES: HubPreferences = {
  view: 'grid',
  density: 'comfortable',
  accent: 'violet',
};

function loadPreferences(): HubPreferences {
  if (typeof window === 'undefined') return DEFAULT_PREFERENCES;
  try {
    const raw = window.localStorage.getItem(HUB_PREFS_KEY);
    if (!raw) return DEFAULT_PREFERENCES;
    return { ...DEFAULT_PREFERENCES, ...JSON.parse(raw) };
  } catch {
    return DEFAULT_PREFERENCES;
  }
}

function formatDate(dateStr?: string | null) {
  if (!dateStr) return 'Sin fecha';
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'Ahora mismo';
  if (diffMins < 60) return `Hace ${diffMins} min`;
  if (diffHours < 24) return `Hace ${diffHours}h`;
  if (diffDays < 7) return `Hace ${diffDays}d`;
  return date.toLocaleDateString('es-MX', { day: 'numeric', month: 'short', year: 'numeric' });
}

function formatDateTime(dateStr?: string | null) {
  if (!dateStr) return 'Sin actividad';
  return new Date(dateStr).toLocaleString('es-MX', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function getProjectRuntimeStats(project: Project): ProjectRuntimeStats {
  const data = project.data as Record<string, unknown> | null;
  const tracks = Array.isArray(data?.tracks) ? data.tracks.length : 0;
  const scenes = Array.isArray(data?.scenes) ? data.scenes.length : 0;
  const devices = Array.isArray(data?.tracks)
    ? data.tracks.reduce((total, track) => {
        const record = track as Record<string, unknown>;
        return total + (Array.isArray(record.devices) ? record.devices.length : 0);
      }, 0)
    : 0;

  let sizeLabel = 'Cloud';
  try {
    const bytes = JSON.stringify(project.data || {}).length;
    if (bytes > 1024 * 1024) {
      sizeLabel = `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    } else if (bytes > 0) {
      sizeLabel = `${Math.max(1, Math.round(bytes / 1024))} KB`;
    }
  } catch {
    sizeLabel = 'Cloud';
  }

  return { tracks, devices, scenes, sizeLabel };
}

function getWorkspaceName(workspace?: WorkspaceSummary) {
  if (!workspace) return 'Workspace';
  return workspace.name || workspace.slug || 'Workspace';
}

function getWorkspaceKind(workspace?: WorkspaceSummary) {
  if (!workspace?.category || workspace.category === 'General') return 'General';
  return workspace.category;
}

function getProjectBand(project: Project) {
  const hue = project.name.split('').reduce((total, char) => total + char.charCodeAt(0), 0) % 360;
  return `linear-gradient(135deg, hsl(${hue} 82% 54%), hsl(${(hue + 54) % 360} 72% 58%))`;
}

function NotificationsMenu({ onPendingCountChange }: { onPendingCountChange?: (count: number) => void }) {
  const { user } = useAuthStore();
  const [isOpen, setIsOpen] = useState(false);
  const [notifications, setNotifications] = useState<NotificationRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const fetchNotifications = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    const { data, error } = await supabase
      .from('user_notifications')
      .select('*')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false });

    if (!error && data) {
      setNotifications(data);
    }
    setLoading(false);
  }, [user]);

  useEffect(() => {
    if (!user) return;
    void fetchNotifications();

    const channel = supabase
      .channel('public:user_notifications')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'user_notifications', filter: `user_id=eq.${user.id}` },
        (payload) => setNotifications((current) => [payload.new as NotificationRecord, ...current])
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [fetchNotifications, user]);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleResponse = async (id: string, status: 'accepted' | 'declined', notification: NotificationRecord) => {
    if (!user) return;
    await supabase.from('user_notifications').update({ status }).eq('id', id);
    setNotifications((current) => current.map((entry) => entry.id === id ? { ...entry, status } : entry));

    if (status !== 'accepted') return;

    if (notification.type === 'project_invite' && notification.project_id) {
      await supabase.from('project_shares').insert({
        project_id: notification.project_id,
        access_level: 'editor',
        invited_email: user.email,
        token: crypto.randomUUID(),
      });
    }

    if (notification.type === 'team_invite' && notification.team_id) {
      await supabase.from('workspace_members').insert({
        workspace_id: notification.team_id,
        user_id: user.id,
        role: 'editor',
      });
    }
  };

  const pendingCount = notifications.filter((entry) => entry.status === 'pending').length;

  useEffect(() => {
    onPendingCountChange?.(pendingCount);
  }, [onPendingCountChange, pendingCount]);

  return (
    <div className="desktop-menu-wrap" ref={menuRef}>
      <button className="desktop-icon-btn" onClick={() => setIsOpen((value) => !value)} title="Notificaciones">
        <Bell size={16} />
        {pendingCount > 0 && <span className="desktop-dot">{pendingCount}</span>}
      </button>
      {isOpen && (
        <div className="desktop-menu desktop-menu--wide">
          <div className="desktop-menu__header">
            <strong>Notificaciones</strong>
            <span className="desktop-meta">{pendingCount} pendientes</span>
          </div>
          <div className="desktop-menu__scroll">
            {loading ? (
              <p className="desktop-meta desktop-menu__empty">Cargando...</p>
            ) : notifications.length === 0 ? (
              <p className="desktop-meta desktop-menu__empty">Sin notificaciones.</p>
            ) : notifications.map((notification) => (
              <div key={notification.id} className={`desktop-notification ${notification.status !== 'pending' ? 'is-muted' : ''}`}>
                <p>{notification.message || 'Notificacion del ecosistema.'}</p>
                <div className="desktop-row">
                  <span className="desktop-meta">{formatDate(notification.created_at)}</span>
                  {notification.status === 'pending' ? (
                    <div className="desktop-row desktop-row--tight">
                      <button onClick={() => handleResponse(notification.id, 'declined', notification)} title="Rechazar"><X size={14} /></button>
                      <button onClick={() => handleResponse(notification.id, 'accepted', notification)} title="Aceptar"><Check size={14} /></button>
                    </div>
                  ) : (
                    <span className="desktop-meta">{notification.status}</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function CreateTeamModal({ onClose, onSuccess }: { onClose: () => void; onSuccess: () => void }) {
  const { user } = useAuthStore();
  const [name, setName] = useState('');
  const [category, setCategory] = useState('Band');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleCreate = async () => {
    if (!name.trim() || !user) return;
    setLoading(true);
    setError(null);

    try {
      const slug = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${Math.random().toString(36).slice(2, 7)}`;
      const { data: workspace, error: createError } = await supabase
        .from('workspaces')
        .insert([{ name: name.trim(), slug, created_by: user.id, category }])
        .select()
        .single();
      if (createError) throw createError;

      const { error: memberError } = await supabase
        .from('workspace_members')
        .insert([{ workspace_id: workspace.id, user_id: user.id, role: 'owner' }]);
      if (memberError) throw memberError;

      onSuccess();
    } catch (error: any) {
      setError(error?.message || 'Error al crear equipo.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="desktop-modal-backdrop">
      <div className="desktop-modal">
        <div className="desktop-row">
          <h3>Crear equipo</h3>
          <button className="desktop-btn" onClick={onClose}><X size={15} /></button>
        </div>
        {error && <div className="desktop-feedback">{error}</div>}
        <label className="desktop-field">
          <span>Nombre del equipo</span>
          <input className="desktop-input" value={name} onChange={(event) => setName(event.target.value)} placeholder="Ej. Mi Banda" />
        </label>
        <label className="desktop-field">
          <span>Categoria</span>
          <select className="desktop-select" value={category} onChange={(event) => setCategory(event.target.value)}>
            <option value="Band">Banda</option>
            <option value="Label">Sello Discografico</option>
            <option value="Studio">Estudio</option>
            <option value="Educational">Educativo</option>
            <option value="Other">Otro</option>
          </select>
        </label>
        <div className="desktop-row desktop-row--end">
          <button className="desktop-btn" onClick={onClose}>Cancelar</button>
          <button className="desktop-btn desktop-btn--primary" onClick={handleCreate} disabled={loading || !name.trim()}>
            {loading ? 'Creando...' : 'Crear equipo'}
          </button>
        </div>
      </div>
    </div>
  );
}

function InviteUserModal({
  contextName,
  onClose,
  projectId,
  teamId,
}: {
  contextName: string;
  onClose: () => void;
  projectId?: string;
  teamId?: string;
}) {
  const { user } = useAuthStore();
  const [target, setTarget] = useState('');
  const [role, setRole] = useState('editor');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const handleInvite = async () => {
    if (!target.trim() || !user) return;
    setLoading(true);
    setError(null);

    try {
      const { data: profileData, error: profileError } = await supabase
        .from('profiles')
        .select('id')
        .or(`username.eq.${target.trim()},full_name.eq.${target.trim()}`)
        .limit(1)
        .single();
      if (profileError || !profileData) throw new Error('No se encontro un usuario con ese identificador.');

      const { error: inviteError } = await supabase
        .from('user_notifications')
        .insert([{
          user_id: profileData.id,
          sender_id: user.id,
          type: teamId ? 'team_invite' : 'project_invite',
          status: 'pending',
          team_id: teamId || null,
          project_id: projectId || null,
          message: `Has sido invitado a colaborar en ${contextName} como ${role}.`,
        }]);
      if (inviteError) throw inviteError;

      setSuccess(true);
      window.setTimeout(onClose, 1400);
    } catch (error: any) {
      setError(error?.message || 'Error al enviar invitacion.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="desktop-modal-backdrop">
      <div className="desktop-modal">
        <div className="desktop-row">
          <div>
            <h3>Invitar usuario</h3>
            <p className="desktop-meta">a {contextName}</p>
          </div>
          <button className="desktop-btn" onClick={onClose}><X size={15} /></button>
        </div>
        {error && <div className="desktop-feedback">{error}</div>}
        {success && <div className="desktop-feedback desktop-feedback--success">Invitacion enviada.</div>}
        <label className="desktop-field">
          <span>Usuario exacto</span>
          <input className="desktop-input" value={target} onChange={(event) => setTarget(event.target.value)} disabled={success} />
        </label>
        {teamId && (
          <label className="desktop-field">
            <span>Rol</span>
            <select className="desktop-select" value={role} onChange={(event) => setRole(event.target.value)} disabled={success}>
              <option value="viewer">Lector</option>
              <option value="editor">Editor</option>
              <option value="admin">Administrador</option>
            </select>
          </label>
        )}
        <div className="desktop-row desktop-row--end">
          <button className="desktop-btn" onClick={onClose}>{success ? 'Cerrar' : 'Cancelar'}</button>
          {!success && (
            <button className="desktop-btn desktop-btn--primary" onClick={handleInvite} disabled={loading || !target.trim()}>
              {loading ? 'Enviando...' : 'Invitar'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export function DesktopHub({ refreshSignal, onLogin, onSettings, onSignup }: DesktopHubProps) {
  const { user, profile, signOut, isLoading } = useAuthStore();
  const [projects, setProjects] = useState<Project[]>([]);
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [license, setLicense] = useState<LicenseRecord | null>(null);
  const [notifications, setNotifications] = useState<NotificationRecord[]>([]);
  const [shareCounts, setShareCounts] = useState<Record<string, number>>({});
  const [activeTab, setActiveTab] = useState<HubTab>('personal');
  const [activeSection, setActiveSection] = useState<HubSection>('library');
  const [activeWorkspaceId, setActiveWorkspaceId] = useState('all');
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [searchValue, setSearchValue] = useState('');
  const [sortMode, setSortMode] = useState<ProjectSort>('updated');
  const [preferences, setPreferences] = useState<HubPreferences>(() => loadPreferences());
  const [pendingNotificationCount, setPendingNotificationCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [contextMenuId, setContextMenuId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [importingFile, setImportingFile] = useState(false);
  const [showCreateTeam, setShowCreateTeam] = useState(false);
  const [inviteContext, setInviteContext] = useState<{ type: 'team' | 'project'; id: string; name: string } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const isFetchingRef = useRef(false);

  useEffect(() => {
    window.localStorage.setItem(HUB_PREFS_KEY, JSON.stringify(preferences));
  }, [preferences]);

  const fetchProjects = useCallback(async () => {
    if (!user || isFetchingRef.current) return;
    isFetchingRef.current = true;
    setLoading(true);

    try {
      const { data: memberships, error } = await supabase
        .from('workspace_members')
        .select('workspace_id, role, joined_at, workspaces(id, created_by, category, name, slug, created_at, updated_at)')
        .eq('user_id', user.id);

      if (error || !memberships || memberships.length === 0) {
        setProjects([]);
        setWorkspaces([]);
        setLicense(null);
        setNotifications([]);
        setShareCounts({});
        return;
      }

      const workspaceMap = new Map<string, WorkspaceSummary>();
      (memberships as any[]).forEach((membership) => {
        if (membership.workspaces) {
          workspaceMap.set(membership.workspace_id, {
            id: membership.workspace_id,
            ...membership.workspaces,
            role: membership.role,
            joined_at: membership.joined_at,
          });
        }
      });
      const nextWorkspaces = Array.from(workspaceMap.values());
      setWorkspaces(nextWorkspaces);

      const workspaceIds = memberships.map((membership) => membership.workspace_id);
      const [{ data: projectData, error: projectError }, { data: licenseData }, { data: notificationData }] = await Promise.all([
        supabase
          .from('projects')
          .select('*')
          .in('workspace_id', workspaceIds)
          .order('updated_at', { ascending: false }),
        supabase
          .from('licenses')
          .select('*')
          .eq('user_id', user.id)
          .maybeSingle(),
        supabase
          .from('user_notifications')
          .select('*')
          .eq('user_id', user.id)
          .order('created_at', { ascending: false })
          .limit(8),
      ]);

      if (!projectError && projectData) {
        const nextProjects = projectData as Project[];
        setProjects(nextProjects);
        const projectIds = nextProjects.map((project) => project.id);
        if (projectIds.length > 0) {
          const { data: sharesData } = await supabase
            .from('project_shares')
            .select('project_id')
            .in('project_id', projectIds);
          const nextShareCounts: Record<string, number> = {};
          (sharesData || []).forEach((share) => {
            if (!share.project_id) return;
            nextShareCounts[share.project_id] = (nextShareCounts[share.project_id] || 0) + 1;
          });
          setShareCounts(nextShareCounts);
        } else {
          setShareCounts({});
        }
      }

      setLicense(licenseData || null);
      setNotifications((notificationData || []) as NotificationRecord[]);
    } finally {
      isFetchingRef.current = false;
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    if (user) {
      void fetchProjects();
    } else {
      setProjects([]);
      setWorkspaces([]);
      setLicense(null);
      setNotifications([]);
      setShareCounts({});
    }
  }, [fetchProjects, refreshSignal, user]);

  useEffect(() => {
    const handleClick = () => setContextMenuId(null);
    if (contextMenuId) {
      window.addEventListener('click', handleClick);
      return () => window.removeEventListener('click', handleClick);
    }
    return undefined;
  }, [contextMenuId]);

  const personalWorkspaceIds = useMemo(
    () => workspaces.filter((workspace) => workspace.created_by === user?.id && (!workspace.category || workspace.category === 'General')).map((workspace) => workspace.id),
    [user?.id, workspaces]
  );

  const sharedWorkspaceIds = useMemo(
    () => workspaces.filter((workspace) => workspace.created_by !== user?.id && (!workspace.category || workspace.category === 'General')).map((workspace) => workspace.id),
    [user?.id, workspaces]
  );

  const teamWorkspaceIds = useMemo(
    () => workspaces.filter((workspace) => workspace.category && workspace.category !== 'General').map((workspace) => workspace.id),
    [workspaces]
  );

  const tabWorkspaceIds = useMemo(() => {
    if (activeTab === 'personal') return personalWorkspaceIds;
    if (activeTab === 'shared') return sharedWorkspaceIds;
    return teamWorkspaceIds;
  }, [activeTab, personalWorkspaceIds, sharedWorkspaceIds, teamWorkspaceIds]);

  const tabWorkspaces = useMemo(
    () => workspaces.filter((workspace) => tabWorkspaceIds.includes(workspace.id)),
    [tabWorkspaceIds, workspaces]
  );

  const filteredProjects = useMemo(() => {
    const query = searchValue.trim().toLowerCase();
    return projects
      .filter((project) => tabWorkspaceIds.includes(project.workspace_id))
      .filter((project) => activeWorkspaceId === 'all' || project.workspace_id === activeWorkspaceId)
      .filter((project) => {
        if (!query) return true;
        const workspace = workspaces.find((entry) => entry.id === project.workspace_id);
        return `${project.name} ${getWorkspaceName(workspace)} ${project.bpm}`.toLowerCase().includes(query);
      })
      .sort((a, b) => {
        if (sortMode === 'name') return a.name.localeCompare(b.name);
        if (sortMode === 'bpm') return a.bpm - b.bpm;
        return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
      });
  }, [activeWorkspaceId, projects, searchValue, sortMode, tabWorkspaceIds, workspaces]);

  useEffect(() => {
    if (!filteredProjects.length) {
      setSelectedProjectId(null);
      return;
    }
    if (!selectedProjectId || !filteredProjects.some((project) => project.id === selectedProjectId)) {
      setSelectedProjectId(filteredProjects[0].id);
    }
  }, [filteredProjects, selectedProjectId]);

  const selectedProject = useMemo(
    () => projects.find((project) => project.id === selectedProjectId) || filteredProjects[0] || null,
    [filteredProjects, projects, selectedProjectId]
  );

  const selectedWorkspace = useMemo(
    () => workspaces.find((workspace) => workspace.id === selectedProject?.workspace_id),
    [selectedProject?.workspace_id, workspaces]
  );

  const recentProjects = useMemo(() => [...projects].sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()).slice(0, 5), [projects]);
  const teamWorkspaces = useMemo(() => workspaces.filter((workspace) => teamWorkspaceIds.includes(workspace.id)), [teamWorkspaceIds, workspaces]);
  const displayName = profile?.username || profile?.full_name || user?.email || 'Invitado';
  const avatarUrl = profile?.avatar_url || user?.user_metadata?.avatar_url || null;
  const selectedStats = selectedProject ? getProjectRuntimeStats(selectedProject) : null;
  const licenseTier = license?.tier || profile?.tier || 'free';
  const licenseStatus = license?.status || 'active';

  const setPreference = (patch: Partial<HubPreferences>) => {
    setPreferences((current) => ({ ...current, ...patch }));
  };

  const openProduct = async (product: DesktopProduct, projectId?: string) => {
    await platformService.openEditor({ product, ...(projectId ? { projectId } : {}) });
  };

  const openEditor = async (projectId?: string) => {
    await openProduct('studio', projectId);
  };

  const createProject = async () => {
    if (!user) {
      await openEditor();
      return;
    }

    const targetWorkspaceId = activeWorkspaceId !== 'all'
      ? activeWorkspaceId
      : tabWorkspaceIds[0] || workspaces[0]?.id;
    if (!targetWorkspaceId) return;

    const { data, error } = await supabase.rpc('create_project_with_limit', {
      p_name: 'Nuevo Proyecto',
      p_workspace_id: targetWorkspaceId,
      p_bpm: 120,
      p_sample_rate: 44100,
      p_is_public: false,
    });

    if (error) {
      alert(error.message.includes('limit reached')
        ? 'Has alcanzado el limite de proyectos para tu plan.'
        : error.message);
      return;
    }

    if (data) {
      await openEditor(data as string);
    }
  };

  const handleImportFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file || !user) return;
    setImportingFile(true);

    try {
      const projectData = JSON.parse(await file.text());
      const targetWorkspaceId = activeWorkspaceId !== 'all'
        ? activeWorkspaceId
        : personalWorkspaceIds[0] || tabWorkspaceIds[0] || workspaces[0]?.id;
      if (!targetWorkspaceId) throw new Error('No workspace');

      const projectName = projectData.name || file.name.replace(/\.esp$/i, '') || 'Proyecto Importado';
      const { data, error } = await supabase
        .from('projects')
        .insert([{
          name: projectName,
          workspace_id: targetWorkspaceId,
          bpm: projectData.bpm || projectData.transport?.bpm || 120,
          sample_rate: projectData.sampleRate || projectData.audioSettings?.sampleRate || 44100,
          data: projectData,
        }])
        .select();
      if (error) throw error;
      if (data) setProjects((current) => [...(data as Project[]), ...current]);
    } catch (error) {
      console.error('[DesktopHub] Import failed:', error);
      alert('Error al importar el archivo. Verifica que sea un .esp valido.');
    } finally {
      setImportingFile(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const startRename = (project: Project) => {
    setRenamingId(project.id);
    setRenameValue(project.name);
    setContextMenuId(null);
  };

  const confirmRename = async () => {
    if (!renamingId || !renameValue.trim()) return;
    const nextName = renameValue.trim();
    const { error } = await supabase
      .from('projects')
      .update({ name: nextName, updated_at: new Date().toISOString() })
      .eq('id', renamingId);
    if (!error) {
      setProjects((current) => current.map((project) => project.id === renamingId ? { ...project, name: nextName } : project));
    }
    setRenamingId(null);
  };

  const duplicateProject = async (project: Project) => {
    if (!user) return;
    setContextMenuId(null);

    const targetWorkspaceId = activeWorkspaceId !== 'all'
      ? activeWorkspaceId
      : project.workspace_id;
    const { data, error } = await supabase
      .from('projects')
      .insert([{
        name: `${project.name} (Copia)`,
        workspace_id: targetWorkspaceId,
        bpm: project.bpm,
        sample_rate: project.sample_rate,
        data: project.data || {},
      }])
      .select();

    if (!error && data) {
      setProjects((current) => [...(data as Project[]), ...current]);
    }
  };

  const confirmDelete = async (id: string) => {
    const { error } = await supabase.from('projects').delete().eq('id', id);
    if (!error) {
      setProjects((current) => current.filter((project) => project.id !== id));
    }
    setDeleteConfirmId(null);
  };

  if (isLoading || loading) {
    return (
      <main className="desktop-hub desktop-hub--loading">
        <div className="desktop-empty">
          <div>
            <div className="desktop-spinner" />
            <p>Cargando DAW-fi...</p>
          </div>
        </div>
      </main>
    );
  }

  const navItems = [
    { id: 'library' as const, label: 'Inicio', icon: <LayoutDashboard size={17} />, count: projects.length },
    { id: 'teams' as const, label: 'Equipos', icon: <Users size={17} />, count: teamWorkspaces.length },
    { id: 'activity' as const, label: 'Actividad', icon: <Activity size={17} />, count: pendingNotificationCount },
    { id: 'personalization' as const, label: 'Ajustes Hub', icon: <Palette size={17} />, count: null },
  ];

  return (
    <main className={`desktop-hub desktop-hub--${preferences.density} desktop-hub--accent-${preferences.accent}`}>
      {showCreateTeam && (
        <CreateTeamModal
          onClose={() => setShowCreateTeam(false)}
          onSuccess={() => {
            setShowCreateTeam(false);
            void fetchProjects();
          }}
        />
      )}
      {inviteContext && (
        <InviteUserModal
          contextName={inviteContext.name}
          onClose={() => setInviteContext(null)}
          teamId={inviteContext.type === 'team' ? inviteContext.id : undefined}
          projectId={inviteContext.type === 'project' ? inviteContext.id : undefined}
        />
      )}
      {deleteConfirmId && (
        <div className="desktop-modal-backdrop">
          <div className="desktop-modal">
            <Trash2 size={30} color="var(--desktop-danger)" />
            <h3>Eliminar proyecto</h3>
            <p className="desktop-kicker">Esta accion es irreversible.</p>
            <div className="desktop-row desktop-row--end">
              <button className="desktop-btn" onClick={() => setDeleteConfirmId(null)}>Cancelar</button>
              <button className="desktop-btn desktop-btn--danger" onClick={() => confirmDelete(deleteConfirmId)}>Eliminar</button>
            </div>
          </div>
        </div>
      )}
      <input ref={fileInputRef} type="file" accept=".esp,.json" style={{ display: 'none' }} onChange={handleImportFile} />

      <aside className="desktop-hub-sidebar">
        <div className="desktop-hub-sidebar__profile">
          {avatarUrl ? (
            <img className="desktop-avatar" src={avatarUrl} alt={displayName} />
          ) : (
            <div className="desktop-avatar">{displayName.charAt(0).toUpperCase()}</div>
          )}
          <div>
            <strong>{displayName}</strong>
            <span>{user ? licenseTier : 'Guest'}</span>
          </div>
        </div>

        <nav className="desktop-hub-nav">
          {navItems.map((item) => (
            <button
              key={item.id}
              className={`desktop-hub-nav__item ${activeSection === item.id ? 'is-active' : ''}`}
              onClick={() => setActiveSection(item.id)}
            >
              {item.icon}
              <span>{item.label}</span>
              {typeof item.count === 'number' && <em>{item.count}</em>}
            </button>
          ))}
        </nav>

        <div className="desktop-hub-sidebar__status">
          <div className="desktop-status-line">
            <ShieldCheck size={15} />
            <span>{licenseStatus}</span>
          </div>
          <div className="desktop-status-meter">
            <span style={{ width: `${Math.min(100, Math.max(12, projects.length * 16))}%` }} />
          </div>
          <p>{projects.length} proyectos · {workspaces.length} workspaces</p>
        </div>

        <div className="desktop-hub-sidebar__footer">
          {user ? (
            <>
              <button className="desktop-btn" onClick={onSettings}><Settings size={15} /> Cuenta</button>
              <button className="desktop-btn desktop-btn--danger" onClick={() => signOut()}><LogOut size={15} /> Salir</button>
            </>
          ) : (
            <>
              <button className="desktop-btn" onClick={onLogin} disabled={!isSupabaseConfigured}>Login</button>
              <button className="desktop-btn desktop-btn--primary" onClick={onSignup} disabled={!isSupabaseConfigured}>Cuenta</button>
            </>
          )}
        </div>
      </aside>

      <section className="desktop-hub-main">
        <header className="desktop-hub-command">
          <div>
            <p className="desktop-command-kicker">DAW-fi</p>
            <h1>Studio Hub</h1>
          </div>
          <div className="desktop-command-actions">
            {user && <NotificationsMenu onPendingCountChange={setPendingNotificationCount} />}
            <button className="desktop-btn" onClick={() => fileInputRef.current?.click()} disabled={!user || importingFile}>
              <Upload size={15} /> {importingFile ? 'Importando...' : 'Importar .esp'}
            </button>
            <button type="button" className="desktop-btn" onClick={() => openProduct('studio')}>
              <Play size={15} /> DAW-fi Studio
            </button>
            <button className="desktop-btn desktop-btn--primary" onClick={createProject}>
              <Plus size={15} /> Nuevo proyecto
            </button>
          </div>
        </header>

        <section className="desktop-product-launcher" aria-labelledby="desktop-products-title">
          <div className="desktop-product-launcher__heading">
            <div>
              <p className="desktop-section-kicker">Herramientas musicales</p>
              <h2 id="desktop-products-title">Elige tu espacio de trabajo</h2>
            </div>
            <p>Un solo proyecto y un mismo motor musical, con interfaces enfocadas para cada tarea.</p>
          </div>
          <div className="desktop-product-grid">
            <button
              type="button"
              className="desktop-product-card"
              data-desktop-product="studio"
              aria-label="Abrir DAW-fi Studio"
              onClick={() => openProduct('studio')}
            >
              <span className="desktop-product-card__icon" aria-hidden="true"><SlidersHorizontal size={19} /></span>
              <span className="desktop-product-card__copy">
                <strong>DAW-fi Studio</strong>
                <small>Producción, arreglo, mezcla y grabación multipista.</small>
              </span>
              <ChevronRight size={17} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="desktop-product-card"
              data-desktop-product="score"
              aria-label="Abrir Score-fi"
              onClick={() => openProduct('score')}
            >
              <span className="desktop-product-card__icon" aria-hidden="true"><Music2 size={19} /></span>
              <span className="desktop-product-card__copy">
                <strong>Score-fi</strong>
                <small>Notación, revisión y edición musical conectada al proyecto.</small>
              </span>
              <ChevronRight size={17} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="desktop-product-card"
              data-desktop-product="keys"
              aria-label="Abrir Keys-fi"
              onClick={() => openProduct('keys')}
            >
              <span className="desktop-product-card__icon" aria-hidden="true"><Piano size={19} /></span>
              <span className="desktop-product-card__copy">
                <strong>Keys-fi</strong>
                <small>Teclado visual, interpretación y seguimiento preciso de notas.</small>
              </span>
              <ChevronRight size={17} aria-hidden="true" />
            </button>
          </div>
        </section>

        {!user ? (
          <section className="desktop-guest-hero">
            <AppLogo size={62} withGlow />
            <div>
              <h2>{isSupabaseConfigured ? 'Hub cloud sin cuenta activa' : 'DAW-fi en modo local'}</h2>
              <p>
                {isSupabaseConfigured
                  ? 'Editor local disponible. Proyectos, equipos, licencia y notificaciones requieren sesión.'
                  : 'El editor y los proyectos locales están disponibles. La nube no está configurada en este build.'}
              </p>
              <div className="desktop-actions">
                <button type="button" className="desktop-btn" onClick={() => openProduct('studio')}><CloudOff size={15} /> Abrir DAW-fi Studio</button>
                <button className="desktop-btn desktop-btn--primary" onClick={onLogin} disabled={!isSupabaseConfigured}>Conectar cuenta</button>
              </div>
            </div>
          </section>
        ) : (
          <>
            <section className="desktop-overview-strip">
              <div className="desktop-overview-card">
                <BarChart3 size={18} />
                <span>{projects.length}</span>
                <p>Proyectos</p>
              </div>
              <div className="desktop-overview-card">
                <Users size={18} />
                <span>{teamWorkspaces.length}</span>
                <p>Equipos</p>
              </div>
              <div className="desktop-overview-card">
                <Bell size={18} />
                <span>{pendingNotificationCount}</span>
                <p>Pendientes</p>
              </div>
              <div className="desktop-overview-card">
                <Zap size={18} />
                <span>{licenseTier}</span>
                <p>Licencia</p>
              </div>
            </section>

            {activeSection === 'library' && (
              <>
                <section className="desktop-library-toolbar">
                  <div className="desktop-tabs desktop-tabs--boxed">
                    {[
                      { id: 'personal' as const, label: 'Mis Proyectos', icon: <FolderOpen size={15} />, count: projects.filter((project) => personalWorkspaceIds.includes(project.workspace_id)).length },
                      { id: 'shared' as const, label: 'Colaborativos', icon: <Users size={15} />, count: projects.filter((project) => sharedWorkspaceIds.includes(project.workspace_id)).length },
                      { id: 'teams' as const, label: 'Equipos', icon: <Cloud size={15} />, count: projects.filter((project) => teamWorkspaceIds.includes(project.workspace_id)).length },
                    ].map((tab) => (
                      <button key={tab.id} className={`desktop-tab ${activeTab === tab.id ? 'is-active' : ''}`} onClick={() => { setActiveTab(tab.id); setActiveWorkspaceId('all'); }}>
                        {tab.icon} {tab.label} <span>{tab.count}</span>
                      </button>
                    ))}
                  </div>

                  <div className="desktop-toolbar-controls">
                    <label className="desktop-search">
                      <Search size={15} />
                      <input value={searchValue} onChange={(event) => setSearchValue(event.target.value)} placeholder="Buscar proyecto, BPM o workspace" />
                    </label>
                    <select className="desktop-select" value={activeWorkspaceId} onChange={(event) => setActiveWorkspaceId(event.target.value)}>
                      <option value="all">Todos los workspaces</option>
                      {tabWorkspaces.map((workspace) => (
                        <option key={workspace.id} value={workspace.id}>{getWorkspaceName(workspace)}</option>
                      ))}
                    </select>
                    <select className="desktop-select" value={sortMode} onChange={(event) => setSortMode(event.target.value as ProjectSort)}>
                      <option value="updated">Actividad</option>
                      <option value="name">Nombre</option>
                      <option value="bpm">BPM</option>
                    </select>
                    <button className="desktop-icon-btn" onClick={() => setPreference({ view: preferences.view === 'grid' ? 'list' : 'grid' })} title="Cambiar vista">
                      {preferences.view === 'grid' ? <List size={16} /> : <Grid3X3 size={16} />}
                    </button>
                    <button className="desktop-icon-btn" onClick={() => fetchProjects()} title="Actualizar">
                      <RefreshCw size={16} />
                    </button>
                  </div>
                </section>

                <section className="desktop-hub-workspace">
                  <div className={`desktop-projects desktop-projects--${preferences.view}`}>
                    {filteredProjects.length === 0 ? (
                      <div className="desktop-empty">
                        <div>
                          <Sparkles size={34} />
                          <p>No hay proyectos en esta vista.</p>
                          {activeTab === 'personal' && <button className="desktop-btn desktop-btn--primary" onClick={createProject}><Plus size={15} /> Crear proyecto</button>}
                          {activeTab === 'teams' && <button className="desktop-btn" onClick={() => setShowCreateTeam(true)}><Cloud size={15} /> Crear equipo</button>}
                        </div>
                      </div>
                    ) : filteredProjects.map((project) => {
                      const stats = getProjectRuntimeStats(project);
                      const workspace = workspaces.find((entry) => entry.id === project.workspace_id);
                      const isSelected = selectedProject?.id === project.id;
                      return (
                        <article
                          key={project.id}
                          className={`desktop-project-card ${isSelected ? 'is-selected' : ''}`}
                          onClick={() => setSelectedProjectId(project.id)}
                          onDoubleClick={() => openEditor(project.id)}
                        >
                          <div className="desktop-project-card__band" style={{ background: getProjectBand(project) }} />
                          <div className="desktop-card__top">
                            <div className="desktop-row desktop-row--start">
                              <div className="desktop-icon-box"><FolderOpen size={21} /></div>
                              <div className="desktop-project-title">
                                {renamingId === project.id ? (
                                  <div className="desktop-row desktop-row--tight" onClick={(event) => event.stopPropagation()}>
                                    <input
                                      className="desktop-input"
                                      value={renameValue}
                                      autoFocus
                                      onChange={(event) => setRenameValue(event.target.value)}
                                      onKeyDown={(event) => {
                                        if (event.key === 'Enter') void confirmRename();
                                        if (event.key === 'Escape') setRenamingId(null);
                                      }}
                                    />
                                    <button className="desktop-btn" onClick={confirmRename}><Check size={14} /></button>
                                  </div>
                                ) : (
                                  <>
                                    <h3 className="desktop-project-name">{project.name}</h3>
                                    <p>{getWorkspaceName(workspace)} · {getWorkspaceKind(workspace)}</p>
                                  </>
                                )}
                              </div>
                            </div>
                            <div className="desktop-menu-wrap" onClick={(event) => event.stopPropagation()}>
                              <button className="desktop-icon-btn" onClick={() => setContextMenuId((current) => current === project.id ? null : project.id)}><MoreVertical size={15} /></button>
                              {contextMenuId === project.id && (
                                <div className="desktop-menu">
                                  <button onClick={() => { setInviteContext({ type: 'project', id: project.id, name: project.name }); setContextMenuId(null); }}><UserPlus size={14} /> Invitar</button>
                                  <button onClick={() => startRename(project)}><Pencil size={14} /> Renombrar</button>
                                  <button onClick={() => duplicateProject(project)}><Copy size={14} /> Duplicar</button>
                                  <button onClick={() => { setDeleteConfirmId(project.id); setContextMenuId(null); }}><Trash2 size={14} /> Eliminar</button>
                                </div>
                              )}
                            </div>
                          </div>

                          <div className="desktop-project-card__metrics">
                            <span><Gauge size={12} /> {project.bpm} BPM</span>
                            <span><HardDrive size={12} /> {(project.sample_rate / 1000).toFixed(1)}kHz</span>
                            <span><Users size={12} /> {shareCounts[project.id] || 0}</span>
                          </div>

                          <div className="desktop-card__bottom">
                            <span className="desktop-meta"><Cloud size={11} /> {formatDate(project.updated_at)}</span>
                            <span className="desktop-meta">{stats.tracks} tracks · {stats.devices} devices</span>
                          </div>
                        </article>
                      );
                    })}
                  </div>

                  <aside className="desktop-inspector">
                    {selectedProject && selectedStats ? (
                      <>
                        <div className="desktop-inspector__header">
                          <span style={{ background: getProjectBand(selectedProject) }} />
                          <div>
                            <h2>{selectedProject.name}</h2>
                            <p>{getWorkspaceName(selectedWorkspace)}</p>
                          </div>
                        </div>
                        <div className="desktop-inspector__actions">
                          <button className="desktop-btn desktop-btn--primary" onClick={() => openEditor(selectedProject.id)}><Play size={15} /> Abrir</button>
                          <button className="desktop-btn" onClick={() => setInviteContext({ type: 'project', id: selectedProject.id, name: selectedProject.name })}><UserPlus size={15} /> Invitar</button>
                        </div>
                        <div className="desktop-inspector-grid">
                          <div><strong>{selectedProject.bpm}</strong><span>BPM</span></div>
                          <div><strong>{(selectedProject.sample_rate / 1000).toFixed(1)}</strong><span>kHz</span></div>
                          <div><strong>{selectedStats.tracks}</strong><span>Tracks</span></div>
                          <div><strong>{selectedStats.sizeLabel}</strong><span>Data</span></div>
                        </div>
                        <div className="desktop-inspector-list">
                          <p><span>Workspace</span><strong>{getWorkspaceName(selectedWorkspace)}</strong></p>
                          <p><span>Categoria</span><strong>{getWorkspaceKind(selectedWorkspace)}</strong></p>
                          <p><span>Yjs room</span><strong>{selectedProject.yjs_room_id.slice(0, 10)}</strong></p>
                          <p><span>Actualizado</span><strong>{formatDateTime(selectedProject.updated_at)}</strong></p>
                        </div>
                      </>
                    ) : (
                      <div className="desktop-empty desktop-empty--flat">
                        <p>Sin proyecto seleccionado.</p>
                      </div>
                    )}
                  </aside>
                </section>
              </>
            )}

            {activeSection === 'teams' && (
              <section className="desktop-section-grid">
                <div className="desktop-section-header">
                  <div>
                    <h2>Equipos y workspaces</h2>
                    <p>{teamWorkspaces.length} espacios colaborativos</p>
                  </div>
                  <button className="desktop-btn desktop-btn--primary" onClick={() => setShowCreateTeam(true)}><Plus size={15} /> Crear equipo</button>
                </div>
                <div className="desktop-team-grid">
                  {teamWorkspaces.length === 0 ? (
                    <div className="desktop-empty">
                      <div>
                        <Users size={34} />
                        <p>Sin equipos activos.</p>
                        <button className="desktop-btn desktop-btn--primary" onClick={() => setShowCreateTeam(true)}>Crear equipo</button>
                      </div>
                    </div>
                  ) : teamWorkspaces.map((workspace) => {
                    const workspaceProjects = projects.filter((project) => project.workspace_id === workspace.id);
                    return (
                      <article key={workspace.id} className="desktop-team-card">
                        <div>
                          <span>{getWorkspaceKind(workspace)}</span>
                          <h3>{getWorkspaceName(workspace)}</h3>
                          <p>{workspace.role || 'member'} · {workspaceProjects.length} proyectos</p>
                        </div>
                        <div className="desktop-team-card__actions">
                          <button className="desktop-btn" onClick={() => { setActiveSection('library'); setActiveTab('teams'); setActiveWorkspaceId(workspace.id); }}>
                            Ver <ChevronRight size={14} />
                          </button>
                          <button className="desktop-btn" onClick={() => setInviteContext({ type: 'team', id: workspace.id, name: getWorkspaceName(workspace) })}>
                            <UserPlus size={14} /> Invitar
                          </button>
                        </div>
                      </article>
                    );
                  })}
                </div>
              </section>
            )}

            {activeSection === 'activity' && (
              <section className="desktop-section-grid desktop-section-grid--two">
                <div className="desktop-activity-panel">
                  <h2>Actividad reciente</h2>
                  {recentProjects.map((project) => (
                    <button key={project.id} className="desktop-activity-row" onClick={() => { setActiveSection('library'); setSelectedProjectId(project.id); }}>
                      <FolderOpen size={16} />
                      <span>{project.name}</span>
                      <em>{formatDate(project.updated_at)}</em>
                    </button>
                  ))}
                </div>
                <div className="desktop-activity-panel">
                  <h2>Inbox</h2>
                  {notifications.length === 0 ? (
                    <p className="desktop-meta">Sin notificaciones recientes.</p>
                  ) : notifications.map((notification) => (
                    <div key={notification.id} className="desktop-activity-note">
                      <strong>{notification.type}</strong>
                      <p>{notification.message}</p>
                      <span>{formatDate(notification.created_at)} · {notification.status}</span>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {activeSection === 'personalization' && (
              <section className="desktop-section-grid desktop-section-grid--two">
                <div className="desktop-preferences-panel">
                  <h2>Preferencias del Hub</h2>
                  <label className="desktop-field">
                    <span><SlidersHorizontal size={13} /> Densidad</span>
                    <div className="desktop-segmented">
                      <button className={preferences.density === 'comfortable' ? 'is-active' : ''} onClick={() => setPreference({ density: 'comfortable' })}>Amplia</button>
                      <button className={preferences.density === 'compact' ? 'is-active' : ''} onClick={() => setPreference({ density: 'compact' })}>Compacta</button>
                    </div>
                  </label>
                  <label className="desktop-field">
                    <span><Grid3X3 size={13} /> Vista</span>
                    <div className="desktop-segmented">
                      <button className={preferences.view === 'grid' ? 'is-active' : ''} onClick={() => setPreference({ view: 'grid' })}>Grid</button>
                      <button className={preferences.view === 'list' ? 'is-active' : ''} onClick={() => setPreference({ view: 'list' })}>Lista</button>
                    </div>
                  </label>
                  <div className="desktop-field">
                    <span><Palette size={13} /> Acento</span>
                    <div className="desktop-swatches">
                      {(['violet', 'cyan', 'rose', 'amber'] as HubAccent[]).map((accent) => (
                        <button key={accent} className={`desktop-swatch desktop-swatch--${accent} ${preferences.accent === accent ? 'is-active' : ''}`} onClick={() => setPreference({ accent })} title={accent} />
                      ))}
                    </div>
                  </div>
                </div>
                <div className="desktop-preferences-panel">
                  <h2>Cuenta y ecosistema</h2>
                  <div className="desktop-inspector-list">
                    <p><span>Perfil</span><strong>{displayName}</strong></p>
                    <p><span>Licencia</span><strong>{licenseTier}</strong></p>
                    <p><span>Estado</span><strong>{licenseStatus}</strong></p>
                    <p><span>Workspaces</span><strong>{workspaces.length}</strong></p>
                  </div>
                  <button className="desktop-btn desktop-btn--primary" onClick={onSettings}><Settings size={15} /> Perfil y seguridad</button>
                </div>
              </section>
            )}
          </>
        )}
      </section>
    </main>
  );
}
