// Generated from the reviewed Solidity 0.8.28 Shanghai artifact; do not hand-edit.
export const GridVaultFactoryAbi = [
  {
    type: 'constructor',
    inputs: [
      {
        name: 'manager_',
        type: 'address',
        internalType: 'address',
      },
      {
        name: 'accountRuntimeHash_',
        type: 'bytes32',
        internalType: 'bytes32',
      },
    ],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'PANCAKE_FACTORY',
    inputs: [],
    outputs: [
      {
        name: '',
        type: 'address',
        internalType: 'address',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'POOL',
    inputs: [],
    outputs: [
      {
        name: '',
        type: 'address',
        internalType: 'address',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'POOL_FEE',
    inputs: [],
    outputs: [
      {
        name: '',
        type: 'uint24',
        internalType: 'uint24',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'REVIEWED_CREATION_CODE_HASH',
    inputs: [],
    outputs: [
      {
        name: '',
        type: 'bytes32',
        internalType: 'bytes32',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'REVIEWED_CREATION_CODE_LENGTH',
    inputs: [],
    outputs: [
      {
        name: '',
        type: 'uint256',
        internalType: 'uint256',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'REVIEWED_MANAGER',
    inputs: [],
    outputs: [
      {
        name: '',
        type: 'address',
        internalType: 'address',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'REVIEWED_MANAGER_CODE_HASH',
    inputs: [],
    outputs: [
      {
        name: '',
        type: 'bytes32',
        internalType: 'bytes32',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'ROUTER',
    inputs: [],
    outputs: [
      {
        name: '',
        type: 'address',
        internalType: 'address',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'USDT',
    inputs: [],
    outputs: [
      {
        name: '',
        type: 'address',
        internalType: 'address',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'WBNB',
    inputs: [],
    outputs: [
      {
        name: '',
        type: 'address',
        internalType: 'address',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'accountRuntimeHash',
    inputs: [],
    outputs: [
      {
        name: '',
        type: 'bytes32',
        internalType: 'bytes32',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'canonicalProtocol',
    inputs: [],
    outputs: [
      {
        name: '',
        type: 'tuple',
        internalType: 'struct GridStrategyVault.Protocol',
        components: [
          {
            name: 'router',
            type: 'address',
            internalType: 'address',
          },
          {
            name: 'factory',
            type: 'address',
            internalType: 'address',
          },
          {
            name: 'pool',
            type: 'address',
            internalType: 'address',
          },
          {
            name: 'token0',
            type: 'address',
            internalType: 'address',
          },
          {
            name: 'token1',
            type: 'address',
            internalType: 'address',
          },
        ],
      },
    ],
    stateMutability: 'pure',
  },
  {
    type: 'function',
    name: 'createForController',
    inputs: [
      {
        name: 'controller',
        type: 'address',
        internalType: 'address',
      },
      {
        name: 'common',
        type: 'tuple',
        internalType: 'struct StrategyVaultBase.CommonPolicy',
        components: [
          {
            name: 'expiresAt',
            type: 'uint64',
            internalType: 'uint64',
          },
          {
            name: 'minInterval',
            type: 'uint32',
            internalType: 'uint32',
          },
          {
            name: 'maxDeadlineDelay',
            type: 'uint32',
            internalType: 'uint32',
          },
        ],
      },
      {
        name: 'policy',
        type: 'tuple',
        internalType: 'struct GridStrategyVault.GridPolicy',
        components: [
          {
            name: 'tickLower',
            type: 'int24',
            internalType: 'int24',
          },
          {
            name: 'tickUpper',
            type: 'int24',
            internalType: 'int24',
          },
          {
            name: 'maxInput0',
            type: 'uint128',
            internalType: 'uint128',
          },
          {
            name: 'maxInput1',
            type: 'uint128',
            internalType: 'uint128',
          },
          {
            name: 'fundingCap0',
            type: 'uint256',
            internalType: 'uint256',
          },
          {
            name: 'fundingCap1',
            type: 'uint256',
            internalType: 'uint256',
          },
          {
            name: 'turnoverCap0',
            type: 'uint256',
            internalType: 'uint256',
          },
          {
            name: 'turnoverCap1',
            type: 'uint256',
            internalType: 'uint256',
          },
          {
            name: 'twapWindow',
            type: 'uint32',
            internalType: 'uint32',
          },
          {
            name: 'maxDeviationTicks',
            type: 'uint24',
            internalType: 'uint24',
          },
          {
            name: 'minLiquidity',
            type: 'uint128',
            internalType: 'uint128',
          },
          {
            name: 'maxSlippageBps',
            type: 'uint16',
            internalType: 'uint16',
          },
          {
            name: 'minFillBps',
            type: 'uint16',
            internalType: 'uint16',
          },
          {
            name: 'minCycleGainBps',
            type: 'uint16',
            internalType: 'uint16',
          },
          {
            name: 'hysteresisTicks',
            type: 'uint24',
            internalType: 'uint24',
          },
        ],
      },
      {
        name: 'rungs',
        type: 'tuple[]',
        internalType: 'struct GridStrategyVault.RungPolicy[]',
        components: [
          {
            name: 'buyTick',
            type: 'int24',
            internalType: 'int24',
          },
          {
            name: 'sellTick',
            type: 'int24',
            internalType: 'int24',
          },
          {
            name: 'lot0',
            type: 'uint128',
            internalType: 'uint128',
          },
          {
            name: 'lot1',
            type: 'uint128',
            internalType: 'uint128',
          },
          {
            name: 'initialSell',
            type: 'bool',
            internalType: 'bool',
          },
        ],
      },
      {
        name: 'creationCode',
        type: 'bytes',
        internalType: 'bytes',
      },
    ],
    outputs: [
      {
        name: 'vault',
        type: 'address',
        internalType: 'contract GridStrategyVault',
      },
    ],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'expectedPolicyHash',
    inputs: [
      {
        name: 'controller',
        type: 'address',
        internalType: 'address',
      },
      {
        name: 'common',
        type: 'tuple',
        internalType: 'struct StrategyVaultBase.CommonPolicy',
        components: [
          {
            name: 'expiresAt',
            type: 'uint64',
            internalType: 'uint64',
          },
          {
            name: 'minInterval',
            type: 'uint32',
            internalType: 'uint32',
          },
          {
            name: 'maxDeadlineDelay',
            type: 'uint32',
            internalType: 'uint32',
          },
        ],
      },
      {
        name: 'policy',
        type: 'tuple',
        internalType: 'struct GridStrategyVault.GridPolicy',
        components: [
          {
            name: 'tickLower',
            type: 'int24',
            internalType: 'int24',
          },
          {
            name: 'tickUpper',
            type: 'int24',
            internalType: 'int24',
          },
          {
            name: 'maxInput0',
            type: 'uint128',
            internalType: 'uint128',
          },
          {
            name: 'maxInput1',
            type: 'uint128',
            internalType: 'uint128',
          },
          {
            name: 'fundingCap0',
            type: 'uint256',
            internalType: 'uint256',
          },
          {
            name: 'fundingCap1',
            type: 'uint256',
            internalType: 'uint256',
          },
          {
            name: 'turnoverCap0',
            type: 'uint256',
            internalType: 'uint256',
          },
          {
            name: 'turnoverCap1',
            type: 'uint256',
            internalType: 'uint256',
          },
          {
            name: 'twapWindow',
            type: 'uint32',
            internalType: 'uint32',
          },
          {
            name: 'maxDeviationTicks',
            type: 'uint24',
            internalType: 'uint24',
          },
          {
            name: 'minLiquidity',
            type: 'uint128',
            internalType: 'uint128',
          },
          {
            name: 'maxSlippageBps',
            type: 'uint16',
            internalType: 'uint16',
          },
          {
            name: 'minFillBps',
            type: 'uint16',
            internalType: 'uint16',
          },
          {
            name: 'minCycleGainBps',
            type: 'uint16',
            internalType: 'uint16',
          },
          {
            name: 'hysteresisTicks',
            type: 'uint24',
            internalType: 'uint24',
          },
        ],
      },
      {
        name: 'rungs',
        type: 'tuple[]',
        internalType: 'struct GridStrategyVault.RungPolicy[]',
        components: [
          {
            name: 'buyTick',
            type: 'int24',
            internalType: 'int24',
          },
          {
            name: 'sellTick',
            type: 'int24',
            internalType: 'int24',
          },
          {
            name: 'lot0',
            type: 'uint128',
            internalType: 'uint128',
          },
          {
            name: 'lot1',
            type: 'uint128',
            internalType: 'uint128',
          },
          {
            name: 'initialSell',
            type: 'bool',
            internalType: 'bool',
          },
        ],
      },
    ],
    outputs: [
      {
        name: '',
        type: 'bytes32',
        internalType: 'bytes32',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'isVault',
    inputs: [
      {
        name: '',
        type: 'address',
        internalType: 'address',
      },
    ],
    outputs: [
      {
        name: '',
        type: 'bool',
        internalType: 'bool',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'manager',
    inputs: [],
    outputs: [
      {
        name: '',
        type: 'address',
        internalType: 'address',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'predictForController',
    inputs: [
      {
        name: 'controller',
        type: 'address',
        internalType: 'address',
      },
      {
        name: 'common',
        type: 'tuple',
        internalType: 'struct StrategyVaultBase.CommonPolicy',
        components: [
          {
            name: 'expiresAt',
            type: 'uint64',
            internalType: 'uint64',
          },
          {
            name: 'minInterval',
            type: 'uint32',
            internalType: 'uint32',
          },
          {
            name: 'maxDeadlineDelay',
            type: 'uint32',
            internalType: 'uint32',
          },
        ],
      },
      {
        name: 'policy',
        type: 'tuple',
        internalType: 'struct GridStrategyVault.GridPolicy',
        components: [
          {
            name: 'tickLower',
            type: 'int24',
            internalType: 'int24',
          },
          {
            name: 'tickUpper',
            type: 'int24',
            internalType: 'int24',
          },
          {
            name: 'maxInput0',
            type: 'uint128',
            internalType: 'uint128',
          },
          {
            name: 'maxInput1',
            type: 'uint128',
            internalType: 'uint128',
          },
          {
            name: 'fundingCap0',
            type: 'uint256',
            internalType: 'uint256',
          },
          {
            name: 'fundingCap1',
            type: 'uint256',
            internalType: 'uint256',
          },
          {
            name: 'turnoverCap0',
            type: 'uint256',
            internalType: 'uint256',
          },
          {
            name: 'turnoverCap1',
            type: 'uint256',
            internalType: 'uint256',
          },
          {
            name: 'twapWindow',
            type: 'uint32',
            internalType: 'uint32',
          },
          {
            name: 'maxDeviationTicks',
            type: 'uint24',
            internalType: 'uint24',
          },
          {
            name: 'minLiquidity',
            type: 'uint128',
            internalType: 'uint128',
          },
          {
            name: 'maxSlippageBps',
            type: 'uint16',
            internalType: 'uint16',
          },
          {
            name: 'minFillBps',
            type: 'uint16',
            internalType: 'uint16',
          },
          {
            name: 'minCycleGainBps',
            type: 'uint16',
            internalType: 'uint16',
          },
          {
            name: 'hysteresisTicks',
            type: 'uint24',
            internalType: 'uint24',
          },
        ],
      },
      {
        name: 'rungs',
        type: 'tuple[]',
        internalType: 'struct GridStrategyVault.RungPolicy[]',
        components: [
          {
            name: 'buyTick',
            type: 'int24',
            internalType: 'int24',
          },
          {
            name: 'sellTick',
            type: 'int24',
            internalType: 'int24',
          },
          {
            name: 'lot0',
            type: 'uint128',
            internalType: 'uint128',
          },
          {
            name: 'lot1',
            type: 'uint128',
            internalType: 'uint128',
          },
          {
            name: 'initialSell',
            type: 'bool',
            internalType: 'bool',
          },
        ],
      },
      {
        name: 'creationCode',
        type: 'bytes',
        internalType: 'bytes',
      },
    ],
    outputs: [
      {
        name: '',
        type: 'address',
        internalType: 'address',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'registeredRuntimeHash',
    inputs: [
      {
        name: '',
        type: 'address',
        internalType: 'address',
      },
    ],
    outputs: [
      {
        name: '',
        type: 'bytes32',
        internalType: 'bytes32',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'event',
    name: 'GridVaultCreated',
    inputs: [
      {
        name: 'vault',
        type: 'address',
        indexed: true,
        internalType: 'address',
      },
      {
        name: 'controller',
        type: 'address',
        indexed: true,
        internalType: 'address',
      },
      {
        name: 'policyHash',
        type: 'bytes32',
        indexed: true,
        internalType: 'bytes32',
      },
      {
        name: 'owner',
        type: 'address',
        indexed: false,
        internalType: 'address',
      },
    ],
    anonymous: false,
  },
  {
    type: 'error',
    name: 'InvalidCreatedVault',
    inputs: [],
  },
  {
    type: 'error',
    name: 'InvalidFactoryConfiguration',
    inputs: [],
  },
  {
    type: 'error',
    name: 'NotControllerOwner',
    inputs: [],
  },
  {
    type: 'error',
    name: 'OccupiedVaultAddress',
    inputs: [],
  },
  {
    type: 'error',
    name: 'UnreviewedController',
    inputs: [],
  },
  {
    type: 'error',
    name: 'UnreviewedCreationCode',
    inputs: [],
  },
  {
    type: 'error',
    name: 'UnreviewedProtocol',
    inputs: [],
  },
  {
    type: 'error',
    name: 'VaultDeploymentFailed',
    inputs: [],
  },
] as const
