<script lang="ts">
  /** Where the hack switches sit and how far they show through. */
  import OverlayPlacement from './OverlayPlacement.svelte';
  import { settings } from '../settings/settings.svelte.js';
</script>

<OverlayPlacement
  corner={settings.value.hacksCorner}
  opacity={settings.value.hacksOpacity}
  oncorner={(corner) => settings.set('hacksCorner', corner)}
  onopacity={(opacity) => settings.set('hacksOpacity', opacity)}
/>
