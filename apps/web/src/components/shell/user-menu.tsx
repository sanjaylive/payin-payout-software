'use client';

import { Avatar, AvatarFallback } from '@pay2all/ui/components/ui/avatar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@pay2all/ui/components/ui/dropdown-menu';
import { initials } from '@pay2all/ui/lib/format';
import { useQueryClient } from '@tanstack/react-query';
import { LogOut, Monitor, Moon, ShieldCheck, Sun } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useTheme } from 'next-themes';
import { logout } from '@/lib/api/client';
import type { Me } from '@/lib/api/types';

export function UserMenu({ me, securityHref }: { me: Me; securityHref: string }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { setTheme } = useTheme();

  async function signOut() {
    await logout();
    queryClient.clear();
    router.replace('/login');
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="hover:bg-accent focus-visible:ring-ring/50 flex items-center gap-2.5 rounded-full py-1 pr-3 pl-1 outline-none focus-visible:ring-[3px]">
        <Avatar className="size-8">
          <AvatarFallback className="bg-primary text-primary-foreground text-xs font-semibold">{initials(me.user.name)}</AvatarFallback>
        </Avatar>
        <span className="hidden text-left leading-tight md:block">
          <span className="block text-sm font-medium">{me.user.name}</span>
          <span className="text-muted-foreground block text-xs">{me.roles.join(', ')}</span>
        </span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuLabel className="font-normal">
          <p className="text-sm font-medium">{me.user.name}</p>
          <p className="text-muted-foreground truncate text-xs">{me.user.email}</p>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => router.push(securityHref)}>
          <ShieldCheck /> Security & sessions
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-muted-foreground text-xs">Theme</DropdownMenuLabel>
        <DropdownMenuItem onSelect={() => setTheme('light')}><Sun /> Light</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => setTheme('dark')}><Moon /> Dark</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => setTheme('system')}><Monitor /> System</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onSelect={() => void signOut()}>
          <LogOut /> Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
