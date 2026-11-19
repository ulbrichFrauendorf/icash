import { rowChoices, retainChoice } from '../../shared/ui/choices';
import { IButton, ICard, ICheckbox, IInputText, ISelect, ITabs, ITabPanel, PageHeaderContentDirective, PageLayoutComponent } from 'invensys-ng';
import { Component, effect, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Ui } from '../../shared/ui/state';

import { OpenAiSettings } from '../openai/openai-settings.component';

@Component({
  selector: 'icash-settings',
  imports: [FormsModule, IButton, IInputText, ISelect, ICheckbox, ICard, ITabs, ITabPanel, OpenAiSettings, PageLayoutComponent, PageHeaderContentDirective],
  templateUrl: './settings.component.html',
})
export class SettingsPage {
  readonly rowChoices = rowChoices;
  readonly selected = retainChoice();
  readonly ui = inject(Ui);
  name = '';
  seed = true;
  passphrase = '';
  confirmation = '';
  payDay = '25';

  constructor() {
    effect(() => {
      const payDay = this.ui.profiles().active?.payDay;
      this.payDay = String(payDay ?? 25);
    });
  }

  validPayDay() {
    return (/^\d{1,2}$/.test(this.payDay) && Number(this.payDay) >= 1 && Number(this.payDay) <= 31);
  }

  savePayDay() {
    if (!this.validPayDay()) return;
    const payDay = Number(this.payDay);
    return this.ui.run(async () => this.ui.state(await this.ui.api.setPayDay({ payDay })), 'Payday saved.');
  }

  select(id: string) { return this.ui.run(async () => this.ui.state(await this.ui.api.selectProfile({ id }))); }
  create() {
    return this.ui.run(async () => {
      this.ui.state(await this.ui.api.createProfile({ name: this.name, seed: this.seed }));
      this.ui.go('Accounts');
    });
  }
  theme(theme: 'light' | 'dark') { return this.ui.setTheme(theme); }
  remove() {
    const active = this.ui.profiles().active;
    if (active && active.name === this.confirmation) return this.ui.run(async () => this.ui.state(await this.ui.api.deleteProfile({ id: active.id })));
  }
  backup() {
    return this.ui.run(async () => {
      try { if (await this.ui.api.exportBackup({ passphrase: this.passphrase })) this.ui.info.set('Encrypted backup saved.'); }
      finally { this.passphrase = ''; }
    });
  }
  restore() {
    return this.ui.run(async () => {
      try {
        const state = await this.ui.api.restoreBackup({ passphrase: this.passphrase });
        if (state) { this.ui.state(state); this.ui.info.set('Backup restored as a new household.'); }
      } finally { this.passphrase = ''; }
    });
  }
}
