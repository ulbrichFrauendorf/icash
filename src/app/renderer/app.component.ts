import { Component, effect, inject } from '@angular/core';
import { NavigationStart, Router } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { IButton, IMessage, ITag, LayoutComponent, LayoutService, type LayoutConfig } from 'invensys-ng';
import { ProfilesPage } from '../../features/profiles/profiles.component';
import { householdMenu, screenPaths } from '../../shared/ui/navigation';
import { Ui } from '../../shared/ui/state';

@Component({
    selector: 'icash-app',
    imports: [LayoutComponent, IButton, ITag, IMessage, ProfilesPage],
    templateUrl: './app.component.html',
})
export class App {
    readonly ui = inject(Ui);
    readonly menu = householdMenu;
    private readonly router = inject(Router);
    private readonly layout = inject(LayoutService);
    readonly config: LayoutConfig = {
        websiteName: 'iCash',
        logoLight: 'assets/branding/invensys-icon-light.png',
        logoDark: 'assets/branding/invensys-icon-dark.png',
        showThemeToggle: false,
    };

    constructor() {
        this.router.events.pipe(takeUntilDestroyed()).subscribe((event) => {
            if (!(event instanceof NavigationStart)) return;
            if (event.url !== '/' + screenPaths.Transactions) this.ui.transactionFilter.set({});
            this.ui.error.set('');
            this.ui.info.set('');
        });
        effect(() => {
            const scheme = this.ui.profiles().active?.theme ?? (localStorage.getItem('viewModeColorScheme') === 'dark' ? 'dark' : 'light');
            document.body.classList.toggle('light', scheme === 'light');
            document.body.classList.toggle('dark', scheme === 'dark');
            this.layout.config.update((config) => config.colorScheme === scheme ? config : { ...config, colorScheme: scheme });
            localStorage.setItem('viewModeColorScheme', scheme);
        });
        void this.ui.load(async () => this.ui.state(await this.ui.api.getProfiles(), false));
    }
}
