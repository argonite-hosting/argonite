import type { IconName } from '../components/Icon';
import type { ProjectType } from '../../../shared/taxonomy';

export const TYPE_ICON: Record<ProjectType, IconName> = {
  mod: 'package',
  plugin: 'server',
  resourcepack: 'image',
  shader: 'sun',
  datapack: 'code',
  modpack: 'layers',
};

export const TYPE_BLURB: Record<ProjectType, string> = {
  mod: 'Fabric, NeoForge, Forge and Quilt mods',
  plugin: 'Paper, Spigot, Velocity and more',
  resourcepack: 'Textures, models, sounds and UI',
  shader: 'Iris, OptiFine and Canvas shaders',
  datapack: 'Vanilla-friendly gameplay tweaks',
  modpack: 'Curated packs, ready to play',
};
