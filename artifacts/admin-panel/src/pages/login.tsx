import { useState } from 'react';
import { useLocation } from 'wouter';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useVerifyToken, type AuthResult } from '@workspace/api-client-react';
import { Shield, Key, Loader2, AlertCircle, Eye, EyeOff } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

export default function Login() {
  const [token, setToken] = useState('');
  const [showToken, setShowToken] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [, setLocation] = useLocation();

  const verifyToken = useVerifyToken();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!token.trim()) return;
    setErrorMsg(null);

    verifyToken.mutate(
      { data: { token } },
      {
        onSuccess: (result: AuthResult) => {
          if (result.success) {
            localStorage.setItem('haru_admin_token', token);
            setLocation('/dashboard');
          } else {
            setErrorMsg(result.message || 'Token không hợp lệ');
          }
        },
        onError: (err: any) => {
          const msg = err?.data?.message || err?.message || 'Xác thực thất bại.';
          setErrorMsg(msg);
        }
      }
    );
  };

  return (
    <div className="min-h-[100dvh] w-full flex items-center justify-center p-4 relative overflow-hidden">
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[800px] h-[800px] bg-primary/5 rounded-full blur-[120px] pointer-events-none" />

      <motion.div
        initial={{ opacity: 0, y: 20, filter: 'blur(10px)' }}
        animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
        transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
        className="w-full max-w-md relative z-10"
      >
        <div className="bg-card/50 backdrop-blur-xl border border-card-border p-8 rounded-2xl shadow-2xl relative overflow-hidden">
          <div className="absolute inset-0 bg-gradient-to-tr from-white/0 via-white/[0.02] to-white/0 pointer-events-none" />

          <div className="flex flex-col items-center mb-8 relative">
            <div className="w-16 h-16 bg-background border border-border rounded-xl flex items-center justify-center mb-6 shadow-inner relative overflow-hidden">
              <div className="absolute inset-0 bg-primary/10" />
              <Shield className="w-8 h-8 text-primary relative z-10" strokeWidth={1.5} />
            </div>
            <h1 className="text-3xl font-bold tracking-tight text-foreground">HARU Control</h1>
            <p className="text-muted-foreground mt-2 text-sm text-center">
              Nhập mật khẩu admin để truy cập hệ thống.
            </p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                Mật khẩu admin
              </label>
              <div className="relative">
                <Key className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <Input
                  type={showToken ? 'text' : 'password'}
                  placeholder="Nhập mật khẩu..."
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  className="pl-10 pr-10 bg-background/80 border-border h-12 font-mono text-sm focus:border-primary/50 transition-colors"
                  disabled={verifyToken.isPending}
                  autoComplete="current-password"
                  spellCheck="false"
                />
                <button
                  type="button"
                  onClick={() => setShowToken((v) => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                  tabIndex={-1}
                >
                  {showToken
                    ? <EyeOff className="w-4 h-4" />
                    : <Eye className="w-4 h-4" />
                  }
                </button>
              </div>
            </div>

            <AnimatePresence mode="wait">
              {errorMsg && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  exit={{ opacity: 0, height: 0 }}
                  className="overflow-hidden"
                >
                  <div className="flex items-center gap-2 text-destructive text-sm bg-destructive/10 p-3 rounded-lg border border-destructive/20">
                    <AlertCircle className="w-4 h-4 shrink-0" />
                    <span>{errorMsg}</span>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            <Button
              type="submit"
              className="w-full h-12 text-sm font-medium tracking-wide uppercase transition-all duration-300"
              disabled={verifyToken.isPending || !token.trim()}
            >
              {verifyToken.isPending
                ? <Loader2 className="w-4 h-4 animate-spin" />
                : 'Đăng nhập'
              }
            </Button>
          </form>
        </div>
      </motion.div>
    </div>
  );
}
