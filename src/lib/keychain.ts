import { execFileSync } from 'child_process';

const SERVICE_PREFIX = 'reline';

interface KeychainEntry {
  service: string;
  account: string;
}

const ENTRIES = {
  salonboardUser:       { service: `${SERVICE_PREFIX}-salonboard`, account: 'salonboard-user' },
  salonboardPass:       { service: `${SERVICE_PREFIX}-salonboard`, account: 'salonboard-pass' },
  lineChannelToken:     { service: `${SERVICE_PREFIX}-line`,       account: 'channel-access-token' },
  lineTargetUserId:     { service: `${SERVICE_PREFIX}-line`,       account: 'target-user-id' },
  anthropicApiKey:      { service: `${SERVICE_PREFIX}-anthropic`,  account: 'api-key' },
  hpbSalonId:           { service: `${SERVICE_PREFIX}-hpb`,        account: 'salon-id' },
} as const;

type EntryKey = keyof typeof ENTRIES;

function get(entry: KeychainEntry): string {
  try {
    return execFileSync('security', [
      'find-generic-password',
      '-s', entry.service,
      '-a', entry.account,
      '-w',
    ], { encoding: 'utf8' }).trim();
  } catch {
    throw new Error(
      `Keychain に "${entry.service}/${entry.account}" が見つかりません。\n` +
      `scripts/setup-keychain.sh を実行して登録してください。`
    );
  }
}

export const keychain = {
  get(key: EntryKey): string {
    return get(ENTRIES[key]);
  },
  salonboardUser: ()   => get(ENTRIES.salonboardUser),
  salonboardPass: ()   => get(ENTRIES.salonboardPass),
  lineChannelToken: () => get(ENTRIES.lineChannelToken),
  lineTargetUserId: () => get(ENTRIES.lineTargetUserId),
  anthropicApiKey: ()  => get(ENTRIES.anthropicApiKey),
  hpbSalonId: ()       => get(ENTRIES.hpbSalonId),
};
