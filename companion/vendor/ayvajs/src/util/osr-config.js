/**
 * Base OSR Configuration for a six axes device.
 */
export default {
  name: 'SR6',
  defaultAxis: 'L0',
  axes: [
    {
      name: 'L0',
      type: 'linear',
      alias: 'stroke',
    },
    {
      name: 'L1',
      type: 'linear',
      alias: 'surge',
    }, {
      name: 'L2',
      type: 'linear',
      alias: 'sway',
    },
    {
      name: 'R0',
      type: 'rotation',
      alias: 'twist',
    },
    {
      name: 'R1',
      type: 'rotation',
      alias: 'roll',
    },
    {
      name: 'R2',
      type: 'rotation',
      alias: 'pitch',
    },
    {
      name: 'A0',
      alias: 'valve',
      type: 'auxiliary',
    },
    {
      name: 'A1',
      alias: 'suck',
      type: 'auxiliary',
    },
    {
      name: 'A2',
      alias: 'lube',
      type: 'auxiliary',
      resetOnStop: true,
    },
    {
      name: 'V0',
      alias: 'vibe0',
      type: 'auxiliary',
      resetOnStop: true,
    },
    {
      name: 'V1',
      alias: 'vibe1',
      type: 'auxiliary',
      resetOnStop: true,
    },
  ],
};
