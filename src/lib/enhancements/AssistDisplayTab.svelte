<script lang="ts">
  /** Where the assistant plates sit and how far they show through. */
  import OverlayPlacement from './OverlayPlacement.svelte';
  import { settings } from '../settings/settings.svelte.js';
</script>

<OverlayPlacement
  corner={settings.value.assistCorner}
  opacity={settings.value.assistOpacity}
  oncorner={(corner) => settings.set('assistCorner', corner)}
  onopacity={(opacity) => settings.set('assistOpacity', opacity)}
/>
