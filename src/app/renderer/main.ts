import { bootstrapApplication } from '@angular/platform-browser';
import { provideRouter, withComponentInputBinding, withHashLocation } from '@angular/router';
import { App } from './app.component';

void bootstrapApplication(App, {
    providers: [
        provideRouter([
            { path: 'overview', loadComponent: () => import('../../features/reports/reports.component').then((m) => m.ReportsPage), data: { detailed: false } },
            { path: 'accounts', loadComponent: () => import('../../features/accounts/accounts.component').then((m) => m.AccountsPage) },
            { path: 'transactions', loadComponent: () => import('../../features/transactions/transactions.component').then((m) => m.TransactionsPage) },
            { path: 'import', loadComponent: () => import('../../features/import-statement/import.component').then((m) => m.ImportPage) },
            { path: 'categories', loadComponent: () => import('../../features/categories/categories.component').then((m) => m.CategoriesPage) },
            { path: 'rules', loadComponent: () => import('../../features/categorization/rules.component').then((m) => m.RulesPage) },
            { path: 'budgets', loadComponent: () => import('../../features/monthly-budget/budgets.component').then((m) => m.BudgetsPage) },
            { path: 'recurring', loadComponent: () => import('../../features/recurring/recurring.component').then((m) => m.RecurringPage) },
            { path: 'savings', loadComponent: () => import('../../features/savings-goals/savings.component').then((m) => m.SavingsPage) },
            { path: 'reports', loadComponent: () => import('../../features/reports/reports.component').then((m) => m.ReportsPage), data: { detailed: true } },
            { path: 'settings', loadComponent: () => import('../../features/profiles/settings.component').then((m) => m.SettingsPage) },
            { path: '**', redirectTo: 'overview' },
        ], withHashLocation(), withComponentInputBinding()),
    ],
});
