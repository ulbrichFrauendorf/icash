import type { MenuModel } from 'invensys-ng';

export const screenPaths = {
    Overview: 'overview',
    Accounts: 'accounts',
    Transactions: 'transactions',
    Import: 'import',
    Budgets: 'budgets',
    Recurring: 'recurring',
    Savings: 'savings',
    Reports: 'reports',
    Categories: 'categories',
    Rules: 'rules',
    Settings: 'settings',
} as const;

export type Screen = keyof typeof screenPaths;

export function revealPageSidebar(id: string) {
    if (matchMedia('(max-width: 61.9375rem)').matches) {
        requestAnimationFrame(() => document.getElementById(id)?.scrollIntoView({ block: 'start' }));
    }
}

function item(screen: Screen, label: string, icon: string) {
    return { label, icon: 'pi pi-fw pi-' + icon, routerLink: ['/', screenPaths[screen]] };
}

export const householdMenu: MenuModel[] = [
    {
        label: 'Household',
        items: [
            item('Overview', 'Overview', 'home'),
            item('Accounts', 'Accounts', 'wallet'),
            item('Transactions', 'Transactions', 'list'),
            item('Import', 'Import statements', 'file-import'),
        ],
    },
    {
        label: 'Planning',
        items: [
            item('Budgets', 'Budgets', 'calculator'),
            item('Recurring', 'Recurring', 'refresh'),
            item('Savings', 'Savings goals', 'flag'),
            item('Reports', 'Reports', 'chart-line'),
        ],
    },
    {
        label: 'Manage',
        items: [
            item('Categories', 'Categories', 'sitemap'),
            item('Rules', 'Rules', 'sliders-h'),
            item('Settings', 'Settings', 'cog'),
        ],
    },
];
