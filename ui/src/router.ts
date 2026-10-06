import { computed, ref } from 'vue';

// A tiny hash router: `#/projects/<id>` is ['projects', '<id>'].
const hash = ref(window.location.hash);
window.addEventListener('hashchange', () => {
  hash.value = window.location.hash;
});

function decode(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}

export const segments = computed(() => hash.value.replace(/^#\/?/, '').split('/').filter(Boolean).map(decode));

export function go(path: string): void {
  window.location.hash = path;
}
