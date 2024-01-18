import { useSettingsStore } from '../stores/settings-store';
import * as R from 'ramda';

export interface UseSettingsReturn<T> {
  value: T | null;
  setValue: (value: T) => Promise<void>;
}

export function useSettings<T>(
  name: string,
  key: string,
): UseSettingsReturn<T> {
  const [value, updateOne] = useSettingsStore((state) => [
    R.path<T>([name, key])(state),
    state.updateOne,
  ]);

  return {
    value: value === undefined ? null : value,
    setValue: async (newVal) => {
      await updateOne(name, key, newVal);
    },
  };
}