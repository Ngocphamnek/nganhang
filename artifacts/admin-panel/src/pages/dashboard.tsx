import { useEffect, useState } from 'react';
import { useLocation } from 'wouter';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  LogOut, Activity, Cpu, Database, Server, Network,
  Key, Settings, Copy, Check, Loader2, RefreshCw, Plus, Eye, EyeOff, Dices
} from 'lucide-react';
import { useHealthCheck } from '@workspace/api-client-react';

// ─── API helpers (direct fetch with x-admin-token header) ─────────────────────

function getToken() {
  return localStorage.getItem('haru_admin_token') ?? '';
}

async function apiFetch(path: string, options: RequestInit = {}) {
  const res = await fetch(`/api${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'x-admin-token': getToken(),
      ...(options.headers ?? {}),
    },
  });
  return res.json();
}

// ─── Products list (mirrors backend) ─────────────────────────────────────────

const PRODUCTS = [
  { id: 1, name: 'Key Test',      durationDays: 1,   price: 10_000 },
  { id: 2, name: 'Key Phổ Thông', durationDays: 7,   price: 50_000 },
  { id: 3, name: 'Key VIP',       durationDays: 30,  price: 145_000 },
  { id: 4, name: 'Key SVIP',      durationDays: 180, price: 599_000 },
  { id: 5, name: 'Key SSVIP',     durationDays: 365, price: 799_000 },
  { id: 6, name: 'Key SSSVIP',    durationDays: 540, price: 999_000 },
];

// ─── Main component ───────────────────────────────────────────────────────────

type Tab = 'overview' | 'keys' | 'settings';

export default function Dashboard() {
  const [, setLocation] = useLocation();
  const [isReady, setIsReady] = useState(false);
  const [tab, setTab] = useState<Tab>('overview');
  const { data: health } = useHealthCheck();

  useEffect(() => {
    const token = localStorage.getItem('haru_admin_token');
    if (!token) {
      setLocation('/');
    } else {
      setIsReady(true);
    }
  }, [setLocation]);

  const handleLogout = () => {
    localStorage.removeItem('haru_admin_token');
    setLocation('/');
  };

  if (!isReady) return null;

  return (
    <div className="min-h-[100dvh] w-full bg-background flex flex-col">
      {/* Header */}
      <header className="border-b border-border bg-card/30 backdrop-blur-md sticky top-0 z-50">
        <div className="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-md bg-primary flex items-center justify-center">
              <Cpu className="w-5 h-5 text-primary-foreground" strokeWidth={1.5} />
            </div>
            <span className="font-bold tracking-tight">HARU Control</span>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={handleLogout}
            className="text-muted-foreground hover:text-foreground"
          >
            <LogOut className="w-4 h-4 mr-2" />
            Đăng xuất
          </Button>
        </div>
      </header>

      {/* Tabs */}
      <div className="border-b border-border bg-card/10">
        <div className="max-w-6xl mx-auto px-6">
          <div className="flex gap-1">
            {([
              { id: 'overview', label: 'Tổng quan',  icon: Server },
              { id: 'keys',     label: 'Tạo Code',   icon: Key },
              { id: 'settings', label: 'Cài đặt',    icon: Settings },
            ] as { id: Tab; label: string; icon: any }[]).map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                onClick={() => setTab(id)}
                className={`flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 transition-colors ${
                  tab === id
                    ? 'border-primary text-foreground'
                    : 'border-transparent text-muted-foreground hover:text-foreground'
                }`}
              >
                <Icon className="w-4 h-4" />
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Content */}
      <main className="flex-1 max-w-6xl mx-auto px-6 py-10 w-full">
        <div key={tab} className="animate-in fade-in duration-200">
          {tab === 'overview' && <OverviewTab health={health} />}
          {tab === 'keys'     && <KeysTab />}
          {tab === 'settings' && <SettingsTab />}
        </div>
      </main>
    </div>
  );
}

// ─── Tab: Tổng quan ──────────────────────────────────────────────────────────

function OverviewTab({ health }: { health: any }) {
  return (
    <div>
      <div className="mb-10">
        <h1 className="text-3xl font-bold tracking-tight mb-2">Tổng quan hệ thống</h1>
        <p className="text-muted-foreground">Kết nối bảo mật đã thiết lập.</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <StatCard
          icon={<Activity className="w-5 h-5" />}
          label="Bot Status"
          value={health?.status === 'ok' ? 'Online' : 'Pending'}
          valueColor={health?.status === 'ok' ? 'text-green-500' : 'text-yellow-500'}
        />
        <StatCard icon={<Network className="w-5 h-5" />} label="Kết nối" value="Bảo mật" valueColor="text-primary" />
        <StatCard icon={<Database className="w-5 h-5" />} label="Database" value="Optimal" />
      </div>

      <div className="mt-10 p-8 rounded-2xl border border-border bg-card/20">
        <div className="flex items-center gap-4 mb-6">
          <Server className="w-6 h-6 text-muted-foreground" />
          <h2 className="text-xl font-semibold">Module đang chạy</h2>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {['Quản lý User', 'Command Router', 'Analytics Engine', 'Bank Monitor'].map((module) => (
            <div key={module} className="p-4 rounded-xl border border-border bg-background/50 flex items-center justify-between group hover:border-primary/30 transition-colors">
              <span className="text-sm font-medium text-muted-foreground group-hover:text-foreground transition-colors">{module}</span>
              <div className="w-2 h-2 rounded-full bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.5)]" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Tab: Tạo Code ───────────────────────────────────────────────────────────

function KeysTab() {
  const [productId, setProductId] = useState(1);
  const [count, setCount] = useState(1);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<string[]>([]);
  const [copied, setCopied] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleGenerate = async () => {
    setLoading(true);
    setError(null);
    setResult([]);
    try {
      const data = await apiFetch('/keys/generate', {
        method: 'POST',
        body: JSON.stringify({ productId, count }),
      });
      if (data.success) {
        setResult(data.keys);
      } else {
        setError(data.message ?? 'Có lỗi xảy ra');
      }
    } catch {
      setError('Không kết nối được API');
    } finally {
      setLoading(false);
    }
  };

  const handleCopy = (key: string) => {
    navigator.clipboard.writeText(key);
    setCopied(key);
    setTimeout(() => setCopied(null), 1500);
  };

  const handleCopyAll = () => {
    navigator.clipboard.writeText(result.join('\n'));
    setCopied('__all__');
    setTimeout(() => setCopied(null), 1500);
  };

  const product = PRODUCTS.find((p) => p.id === productId)!;

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-3xl font-bold tracking-tight mb-2">Tạo Code</h1>
        <p className="text-muted-foreground">Tạo key kích hoạt và giao cho người dùng.</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        {/* Form */}
        <div className="p-6 rounded-2xl border border-border bg-card/20 space-y-5">
          <h2 className="font-semibold text-lg">Cấu hình</h2>

          {/* Product selector */}
          <div className="space-y-2">
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Loại gói</label>
            <div className="grid grid-cols-2 gap-2">
              {PRODUCTS.map((p) => (
                <button
                  key={p.id}
                  onClick={() => setProductId(p.id)}
                  className={`p-3 rounded-xl border text-left transition-colors ${
                    productId === p.id
                      ? 'border-primary bg-primary/10 text-foreground'
                      : 'border-border bg-background/50 text-muted-foreground hover:border-primary/40'
                  }`}
                >
                  <div className="text-sm font-medium">{p.name}</div>
                  <div className="text-xs mt-0.5 opacity-70">{p.durationDays} ngày · {p.price.toLocaleString('vi-VN')}đ</div>
                </button>
              ))}
            </div>
          </div>

          {/* Count */}
          <div className="space-y-2">
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Số lượng (tối đa 100)</label>
            <Input
              type="number"
              min={1}
              max={100}
              value={count}
              onChange={(e) => setCount(Math.max(1, Math.min(100, parseInt(e.target.value) || 1)))}
              className="bg-background/80 border-border h-11"
            />
          </div>

          {error && (
            <p className="text-sm text-destructive bg-destructive/10 p-3 rounded-lg border border-destructive/20">{error}</p>
          )}

          <Button onClick={handleGenerate} disabled={loading} className="w-full h-11">
            {loading ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Plus className="w-4 h-4 mr-2" />}
            Tạo {count} code · {product.name}
          </Button>
        </div>

        {/* Results */}
        <div className="p-6 rounded-2xl border border-border bg-card/20 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold text-lg">Kết quả</h2>
            {result.length > 0 && (
              <Button variant="ghost" size="sm" onClick={handleCopyAll} className="text-xs text-muted-foreground">
                {copied === '__all__' ? <Check className="w-3.5 h-3.5 mr-1 text-green-500" /> : <Copy className="w-3.5 h-3.5 mr-1" />}
                Copy tất cả
              </Button>
            )}
          </div>

          {result.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-muted-foreground gap-3">
              <Key className="w-10 h-10 opacity-20" />
              <p className="text-sm">Chưa có code nào — nhấn Tạo để bắt đầu</p>
            </div>
          ) : (
            <div className="space-y-2 max-h-96 overflow-y-auto pr-1">
              {result.map((key) => (
                <div
                  key={key}
                  className="flex items-center justify-between p-3 rounded-xl bg-background/60 border border-border group hover:border-primary/30 transition-colors"
                >
                  <span className="font-mono text-sm tracking-wider text-foreground">{key}</span>
                  <button
                    onClick={() => handleCopy(key)}
                    className="opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-foreground"
                  >
                    {copied === key
                      ? <Check className="w-4 h-4 text-green-500" />
                      : <Copy className="w-4 h-4" />
                    }
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Tab: Cài đặt ────────────────────────────────────────────────────────────

function SettingsTab() {
  const [channel, setChannel] = useState('');
  const [botToken, setBotToken] = useState('');
  const [botTokenMasked, setBotTokenMasked] = useState('');
  const [botTokenSet, setBotTokenSet] = useState(false);
  const [showToken, setShowToken] = useState(true);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<'channel' | 'token' | null>(null);
  const [saved, setSaved] = useState<'channel' | 'token' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [xucxacRefreshing, setXucxacRefreshing] = useState(false);
  const [xucxacResult, setXucxacResult] = useState<{ ok: boolean; msg: string } | null>(null);

  useEffect(() => {
    apiFetch('/settings')
      .then((data) => {
        setChannel(data.txcChannel ?? '');
        setBotTokenSet(data.botTokenSet ?? false);
        setBotTokenMasked(data.botTokenMasked ?? '');
      })
      .catch(() => setError('Không tải được cài đặt'))
      .finally(() => setLoading(false));
  }, []);

  const handleXucXacRefresh = async () => {
    setXucxacRefreshing(true);
    setXucxacResult(null);
    try {
      const data = await apiFetch('/games/xucxac/refresh', { method: 'POST' });
      setXucxacResult({ ok: data.success, msg: data.message ?? (data.success ? 'Thành công!' : 'Lỗi không xác định') });
    } catch {
      setXucxacResult({ ok: false, msg: 'Không kết nối được API' });
    } finally {
      setXucxacRefreshing(false);
    }
  };

  const handleSaveChannel = async () => {
    setSaving('channel');
    setError(null);
    try {
      const data = await apiFetch('/settings', {
        method: 'PUT',
        body: JSON.stringify({ txcChannel: channel }),
      });
      if (data.success) {
        setSaved('channel');
        setTimeout(() => setSaved(null), 2000);
      } else {
        setError(data.message ?? 'Lỗi khi lưu');
      }
    } catch {
      setError('Không kết nối được API');
    } finally {
      setSaving(null);
    }
  };

  const handleSaveToken = async () => {
    if (!botToken.trim()) return;
    setSaving('token');
    setError(null);
    try {
      const data = await apiFetch('/settings', {
        method: 'PUT',
        body: JSON.stringify({ botToken }),
      });
      if (data.success) {
        setBotTokenSet(true);
        setBotTokenMasked(botToken.slice(0, 8) + '…' + botToken.slice(-4));
        setBotToken('');
        setShowToken(false);
        setSaved('token');
        setTimeout(() => setSaved(null), 2000);
      } else {
        setError(data.message ?? 'Lỗi khi lưu');
      }
    } catch {
      setError('Không kết nối được API');
    } finally {
      setSaving(null);
    }
  };

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-3xl font-bold tracking-tight mb-2">Cài đặt</h1>
        <p className="text-muted-foreground">Cấu hình hệ thống và tích hợp Telegram.</p>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-muted-foreground text-sm">
          <Loader2 className="w-4 h-4 animate-spin" /> Đang tải...
        </div>
      ) : (
        <div className="max-w-lg space-y-6">

          {/* Bot Token */}
          <div className="p-6 rounded-2xl border border-border bg-card/20 space-y-5">
            <div>
              <h2 className="font-semibold text-lg mb-1">Telegram Bot Token</h2>
              <p className="text-sm text-muted-foreground">
                Token lấy từ @BotFather. Dùng để bot gửi/nhận tin nhắn.
              </p>
            </div>

            {botTokenSet && !botToken && (
              <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-green-500/10 border border-green-500/20 text-sm">
                <Check className="w-4 h-4 text-green-500 shrink-0" />
                <span className="text-green-400 font-mono">{botTokenMasked}</span>
                <span className="text-muted-foreground ml-1">— đã cài</span>
              </div>
            )}

            <div className="space-y-2">
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                {botTokenSet ? 'Nhập token mới để thay đổi' : 'Bot Token'}
              </label>
              <div className="relative">
                <Input
                  type={showToken ? 'text' : 'password'}
                  value={botToken}
                  onChange={(e) => setBotToken(e.target.value)}
                  placeholder="123456:ABCdef..."
                  className="pr-10 bg-background/80 border-border h-11 font-mono text-sm"
                />
                <button
                  type="button"
                  onClick={() => setShowToken((v) => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                >
                  {showToken ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            {error && (
              <p className="text-sm text-destructive bg-destructive/10 p-3 rounded-lg border border-destructive/20">{error}</p>
            )}

            <Button
              onClick={handleSaveToken}
              disabled={saving === 'token' || !botToken.trim()}
              className="w-full h-11"
            >
              {saving === 'token' ? (
                <Loader2 className="w-4 h-4 animate-spin mr-2" />
              ) : saved === 'token' ? (
                <Check className="w-4 h-4 mr-2 text-green-400" />
              ) : (
                <Key className="w-4 h-4 mr-2" />
              )}
              {saved === 'token' ? 'Đã lưu!' : botTokenSet ? 'Cập nhật Token' : 'Lưu Token'}
            </Button>
          </div>

          {/* TXC Channel */}
          <div className="p-6 rounded-2xl border border-border bg-card/20 space-y-5">
            <div>
              <h2 className="font-semibold text-lg mb-1">Kênh đọc lịch sử Tài Xỉu</h2>
              <p className="text-sm text-muted-foreground">
                Username kênh Telegram chứa lịch sử phiên (không cần @).
              </p>
            </div>

            <div className="space-y-2">
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                Username kênh
              </label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm font-mono">@</span>
                <Input
                  value={channel}
                  onChange={(e) => setChannel(e.target.value.replace(/^@/, ''))}
                  placeholder="lichsuphienclmmgg"
                  className="pl-8 bg-background/80 border-border h-11 font-mono text-sm"
                />
              </div>
            </div>

            <Button
              onClick={handleSaveChannel}
              disabled={saving === 'channel' || !channel.trim()}
              className="w-full h-11"
            >
              {saving === 'channel' ? (
                <Loader2 className="w-4 h-4 animate-spin mr-2" />
              ) : saved === 'channel' ? (
                <Check className="w-4 h-4 mr-2 text-green-400" />
              ) : (
                <RefreshCw className="w-4 h-4 mr-2" />
              )}
              {saved === 'channel' ? 'Đã lưu!' : 'Lưu thay đổi'}
            </Button>
          </div>

          {/* Xúc Xắc — Làm mới dữ liệu */}
          <div className="p-6 rounded-2xl border border-border bg-card/20 space-y-5">
            <div className="flex items-center gap-3">
              <Dices className="w-5 h-5 text-muted-foreground" />
              <div>
                <h2 className="font-semibold text-lg leading-tight">Xúc Xắc — Làm mới dữ liệu</h2>
                <p className="text-sm text-muted-foreground mt-0.5">
                  Xoá toàn bộ phiên cũ trong bộ nhớ, tải lại 100 phiên mới nhất từ Telegram.
                </p>
              </div>
            </div>

            {xucxacResult && (
              <div className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm border ${
                xucxacResult.ok
                  ? 'bg-green-500/10 border-green-500/20 text-green-400'
                  : 'bg-destructive/10 border-destructive/20 text-destructive'
              }`}>
                {xucxacResult.ok
                  ? <Check className="w-4 h-4 shrink-0" />
                  : <span className="shrink-0">⚠️</span>}
                {xucxacResult.msg}
              </div>
            )}

            <Button
              onClick={handleXucXacRefresh}
              disabled={xucxacRefreshing}
              variant="outline"
              className="w-full h-11"
            >
              {xucxacRefreshing
                ? <Loader2 className="w-4 h-4 animate-spin mr-2" />
                : <RefreshCw className="w-4 h-4 mr-2" />}
              {xucxacRefreshing ? 'Đang tải 100 phiên...' : 'Xoá & Tải lại 100 phiên'}
            </Button>
          </div>

          <div className="p-5 rounded-xl border border-border/50 bg-muted/10 text-sm text-muted-foreground space-y-1">
            <p className="font-medium text-foreground/70">Lưu ý</p>
            <p>• Bot Token lưu trong database, áp dụng khi restart bot.</p>
            <p>• MTProto cần <code className="font-mono bg-muted px-1 rounded">TELEGRAM_API_ID</code> và <code className="font-mono bg-muted px-1 rounded">TELEGRAM_API_HASH</code> trong Replit Secrets.</p>
            <p>• Đổi kênh TXC có hiệu lực ngay lần phân tích tiếp theo.</p>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Shared components ────────────────────────────────────────────────────────

function StatCard({ icon, label, value, valueColor = 'text-foreground' }: {
  icon: React.ReactNode; label: string; value: string; valueColor?: string;
}) {
  return (
    <div className="p-6 rounded-2xl border border-border bg-card/30 backdrop-blur-sm flex flex-col gap-4 relative overflow-hidden">
      <div className="w-10 h-10 rounded-lg bg-background border border-border flex items-center justify-center text-muted-foreground">
        {icon}
      </div>
      <div>
        <p className="text-sm font-medium text-muted-foreground mb-1">{label}</p>
        <p className={`text-2xl font-semibold tracking-tight ${valueColor}`}>{value}</p>
      </div>
    </div>
  );
}
