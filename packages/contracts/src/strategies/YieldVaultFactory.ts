// Generated from the reviewed Solidity 0.8.28 Shanghai artifact; do not hand-edit.
export const YieldVaultFactoryAbi = [
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
    name: 'AAVE_DATA_PROVIDER',
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
    name: 'AAVE_POOL',
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
    name: 'AAVE_PROVIDER',
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
    name: 'AAVE_USDT_RECEIPT',
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
    name: 'VENUS_COMPTROLLER',
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
    name: 'VENUS_USDT',
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
    name: 'canonicalVenues',
    inputs: [],
    outputs: [
      {
        name: '',
        type: 'tuple',
        internalType: 'struct YieldAllocationVault.Venues',
        components: [
          {
            name: 'underlying',
            type: 'address',
            internalType: 'address',
          },
          {
            name: 'venus',
            type: 'address',
            internalType: 'address',
          },
          {
            name: 'comptroller',
            type: 'address',
            internalType: 'address',
          },
          {
            name: 'aavePool',
            type: 'address',
            internalType: 'address',
          },
          {
            name: 'aaveProvider',
            type: 'address',
            internalType: 'address',
          },
          {
            name: 'aaveDataProvider',
            type: 'address',
            internalType: 'address',
          },
          {
            name: 'aaveReceipt',
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
        internalType: 'struct YieldAllocationVault.YieldPolicy',
        components: [
          {
            name: 'maxPrincipal',
            type: 'uint256',
            internalType: 'uint256',
          },
          {
            name: 'maxMove',
            type: 'uint256',
            internalType: 'uint256',
          },
          {
            name: 'maxTurnover',
            type: 'uint256',
            internalType: 'uint256',
          },
          {
            name: 'minIdle',
            type: 'uint256',
            internalType: 'uint256',
          },
          {
            name: 'maxVenusExposure',
            type: 'uint256',
            internalType: 'uint256',
          },
          {
            name: 'maxAaveExposure',
            type: 'uint256',
            internalType: 'uint256',
          },
          {
            name: 'maxLossPerMove',
            type: 'uint256',
            internalType: 'uint256',
          },
          {
            name: 'maxCumulativeLoss',
            type: 'uint256',
            internalType: 'uint256',
          },
          {
            name: 'maxLossBps',
            type: 'uint16',
            internalType: 'uint16',
          },
        ],
      },
    ],
    outputs: [
      {
        name: 'vault',
        type: 'address',
        internalType: 'contract YieldAllocationVault',
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
        internalType: 'struct YieldAllocationVault.YieldPolicy',
        components: [
          {
            name: 'maxPrincipal',
            type: 'uint256',
            internalType: 'uint256',
          },
          {
            name: 'maxMove',
            type: 'uint256',
            internalType: 'uint256',
          },
          {
            name: 'maxTurnover',
            type: 'uint256',
            internalType: 'uint256',
          },
          {
            name: 'minIdle',
            type: 'uint256',
            internalType: 'uint256',
          },
          {
            name: 'maxVenusExposure',
            type: 'uint256',
            internalType: 'uint256',
          },
          {
            name: 'maxAaveExposure',
            type: 'uint256',
            internalType: 'uint256',
          },
          {
            name: 'maxLossPerMove',
            type: 'uint256',
            internalType: 'uint256',
          },
          {
            name: 'maxCumulativeLoss',
            type: 'uint256',
            internalType: 'uint256',
          },
          {
            name: 'maxLossBps',
            type: 'uint16',
            internalType: 'uint16',
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
        internalType: 'struct YieldAllocationVault.YieldPolicy',
        components: [
          {
            name: 'maxPrincipal',
            type: 'uint256',
            internalType: 'uint256',
          },
          {
            name: 'maxMove',
            type: 'uint256',
            internalType: 'uint256',
          },
          {
            name: 'maxTurnover',
            type: 'uint256',
            internalType: 'uint256',
          },
          {
            name: 'minIdle',
            type: 'uint256',
            internalType: 'uint256',
          },
          {
            name: 'maxVenusExposure',
            type: 'uint256',
            internalType: 'uint256',
          },
          {
            name: 'maxAaveExposure',
            type: 'uint256',
            internalType: 'uint256',
          },
          {
            name: 'maxLossPerMove',
            type: 'uint256',
            internalType: 'uint256',
          },
          {
            name: 'maxCumulativeLoss',
            type: 'uint256',
            internalType: 'uint256',
          },
          {
            name: 'maxLossBps',
            type: 'uint16',
            internalType: 'uint16',
          },
        ],
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
    name: 'YieldVaultCreated',
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
    name: 'VaultDeploymentFailed',
    inputs: [],
  },
] as const
