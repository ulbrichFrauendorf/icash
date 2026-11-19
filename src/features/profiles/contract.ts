import { z } from 'zod';
import { id, name, theme } from '../../shared/schema';

export const createProfileInput = z.object({ name, seed: z.boolean() });
export const profileIdInput = z.object({ id });
export const selectThemeInput = z.object({ theme });
export const payDayInput = z.object({ payDay: z.int().min(1).max(31) });
export type Profile = { id: string; name: string };
export type ActiveProfile = Profile & { theme: z.infer<typeof theme>; payDay: number };
export type ProfileState = { profiles: Profile[]; active: ActiveProfile | null };
