import React, { createContext, useContext, useState, useCallback, ReactNode } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X, CheckCircle2, AlertCircle, Info, BellRing } from "lucide-react";
import { cn } from "@/lib/dashboard-utils";

export type ToastType = "default" | "success" | "error" | "payment";

export interface ToastMessage {
  id: string;
  title: string;
  description?: string;
  type?: ToastType;
}

interface ToastContextType {
  toast: (message: Omit<ToastMessage, "id">) => void;
  dismiss: (id: string) => void;
}

const ToastContext = createContext<ToastContextType | undefined>(undefined);

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) throw new Error("useToast must be used within ToastProvider");
  return context;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastMessage[]>([]);

  const toast = useCallback((message: Omit<ToastMessage, "id">) => {
    const id = Math.random().toString(36).substring(2, 9);
    setToasts((prev) => [...prev, { ...message, id }]);
    
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 5000);
  }, []);

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  return (
    <ToastContext.Provider value={{ toast, dismiss }}>
      {children}
      <div className="fixed bottom-0 right-0 z-50 p-4 md:p-6 w-full max-w-sm flex flex-col gap-3 pointer-events-none">
        <AnimatePresence>
          {toasts.map((t) => (
            <motion.div
              key={t.id}
              initial={{ opacity: 0, y: 50, scale: 0.95 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95, transition: { duration: 0.2 } }}
              className={cn(
                "pointer-events-auto relative w-full overflow-hidden rounded-xl border p-4 shadow-lg bg-card flex items-start gap-3",
                t.type === "success" && "border-green-200",
                t.type === "error" && "border-red-200",
                t.type === "payment" && "border-foreground/20",
                (!t.type || t.type === "default") && "border-border"
              )}
            >
              <div className={cn("mt-0.5 shrink-0", 
                t.type === "success" ? "text-green-600" : 
                t.type === "error" ? "text-red-600" : 
                t.type === "payment" ? "text-foreground" : "text-muted-foreground"
              )}>
                {t.type === "success" && <CheckCircle2 className="w-5 h-5" />}
                {t.type === "error" && <AlertCircle className="w-5 h-5" />}
                {t.type === "payment" && <BellRing className="w-5 h-5" />}
                {(!t.type || t.type === "default") && <Info className="w-5 h-5" />}
              </div>
              
              <div className="flex-1 space-y-0.5">
                <p className="text-sm font-medium leading-none">{t.title}</p>
                {t.description && (
                  <p className="text-sm text-muted-foreground leading-snug">{t.description}</p>
                )}
              </div>
              
              <button
                onClick={() => dismiss(t.id)}
                className="shrink-0 p-1 rounded-md hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"
              >
                <X className="w-4 h-4" />
              </button>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </ToastContext.Provider>
  );
}
