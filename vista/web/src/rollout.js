// Vista rollout switch: on/off by location, opt-out by account.
//   off   -> nobody at the location uses Vista (Jotform as today)
//   pilot -> only the accounts in pilotAccounts
//   on    -> everyone except the accounts in optOutAccounts
// Location = the job's Office (Location). Account = the installer's / measure tech's Account.
// The same rules run in the Vista API against config/rollout.json. See docs/rollout.md.

export function locationRule(cfg, location) {
  const byKey = cfg?.locations || {};
  const r = byKey[location?.Id] || byKey[location?.Name];
  return { mode: r?.mode || cfg?.defaultMode || 'off', pilot: r?.pilotAccounts || [], optOut: r?.optOutAccounts || [] };
}
const listed = (list, acct) => !!acct && list.some(x => x === acct.Id || x === acct.Name);

// Is Vista on for this account at this location?
export function vistaOn(cfg, location, account) {
  const r = locationRule(cfg, location);
  if (r.mode === 'on') return !listed(r.optOut, account);
  if (r.mode === 'pilot') return listed(r.pilot, account);
  return false;
}
