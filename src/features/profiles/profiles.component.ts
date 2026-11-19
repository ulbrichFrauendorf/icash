import { IAccordion, IButton, ICard, ICheckbox, IInputText, ITable, PageLayoutComponent, type GridData } from 'invensys-ng';
import { Component, computed, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Ui } from '../../shared/ui/state';
import type { Profile } from './contract';

@Component({
  selector: 'icash-profiles',
  imports: [FormsModule, IButton, IInputText, ICheckbox, ICard, IAccordion, ITable, PageLayoutComponent],
  templateUrl: './profiles.component.html',
})
export class ProfilesPage {
  readonly ui = inject(Ui);
  readonly grid = computed((): GridData<Profile> => ({
    columns: [{ field: 'name', header: 'Household', sortable: true }],
    rows: this.ui.profiles().profiles,
    actions: [{ id: 'open', icon: 'pi pi-arrow-right', tooltip: (row) => 'Open ' + row.name,
      disabled: () => this.ui.busy(), handler: (row) => this.open(row.id) }],
  }));
  name = '';
  seed = true;
  passphrase = '';

  open(id: string) { return this.ui.run(async () => this.ui.state(await this.ui.api.selectProfile({ id }))); }
  create() {
    return this.ui.run(async () => {
      this.ui.state(await this.ui.api.createProfile({ name: this.name, seed: this.seed }));
      this.ui.go('Accounts');
    });
  }
  restore() {
    return this.ui.run(async () => {
      try {
        const state = await this.ui.api.restoreBackup({ passphrase: this.passphrase });
        if (state) this.ui.state(state);
      } finally { this.passphrase = ''; }
    });
  }
}
