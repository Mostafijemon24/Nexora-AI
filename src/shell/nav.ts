import { BarChart3, LayoutDashboard, MessageSquare, PenLine, Plug, SlidersHorizontal, Sparkles, Users, Workflow, type LucideIcon } from 'lucide-react';
import type { ScreenId } from '../lib/types';

export const NAV: { id: ScreenId; label: string; icon: LucideIcon }[] = [
  { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { id: 'leads', label: 'Leads', icon: Users },
  { id: 'ai', label: 'AI Intelligence', icon: Sparkles },
  { id: 'content', label: 'Content Studio', icon: PenLine },
  { id: 'inbox', label: 'Communication', icon: MessageSquare },
  { id: 'automation', label: 'Automation', icon: Workflow },
  { id: 'reports', label: 'Reports', icon: BarChart3 },
  { id: 'integrations', label: 'Integrations', icon: Plug },
  { id: 'settings', label: 'Settings', icon: SlidersHorizontal },
];

export const TITLES = Object.fromEntries(NAV.map((n) => [n.id, n.label])) as Record<ScreenId, string>;
