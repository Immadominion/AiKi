'use client'

import Image from 'next/image'
import { useEffect, useRef } from 'react'
import { useEscapeLayer } from '@/lib/escape'
import type { WalletOption } from '@/lib/wallet'

export function WalletPicker({
  wallets,
  onSelect,
  onClose,
}: {
  wallets: WalletOption[]
  onSelect: (wallet: WalletOption) => void
  onClose: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  useEscapeLayer(true, onClose)
  useEffect(() => {
    dialog.current?.showModal()
    const element = dialog.current
    return () => element?.close()
  }, [])

  return (
    <dialog
      ref={dialog}
      aria-labelledby="wallet-picker-title"
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
      className="fixed inset-0 m-auto w-[calc(100%_-_32px)] max-w-[400px] rounded-[24px] border border-black/5 bg-white p-6 text-[#171717] shadow-2xl backdrop:bg-black/30 backdrop:backdrop-blur-sm"
    >
      <div className="flex items-center justify-between gap-4">
        <h2 id="wallet-picker-title" className="m-0 text-[22px] font-bold tracking-tight">
          Connect your wallet
        </h2>
        <button
          type="button"
          aria-label="Close wallet picker"
          onClick={onClose}
          className="flex size-8 items-center justify-center rounded-full bg-black/5 text-xl hover:bg-black/10"
        >
          ×
        </button>
      </div>
      <p className="mt-2 mb-5 text-[13px] leading-relaxed text-[#686868]">
        Choose the wallet you want to use with AiKi. Signing in does not move any money.
      </p>
      <div className="flex flex-col gap-2">
        {wallets.map((wallet) => (
          <button
            type="button"
            key={wallet.uuid}
            onClick={() => onSelect(wallet)}
            className="flex items-center gap-3 rounded-[16px] border border-black/10 px-4 py-3 text-left transition-colors hover:border-orange-400 hover:bg-orange-50 focus-visible:outline-2 focus-visible:outline-orange-500"
          >
            <span className="flex size-10 items-center justify-center rounded-xl bg-[#f4f4f4] text-lg font-bold">
              {/^data:image\/(png|webp|svg\+xml);/i.test(wallet.icon) ? (
                <Image
                  src={wallet.icon}
                  alt=""
                  width={28}
                  height={28}
                  unoptimized
                  className="size-7 object-contain"
                />
              ) : (
                wallet.name.slice(0, 1)
              )}
            </span>
            <span className="flex-1 text-[15px] font-semibold">{wallet.name}</span>
            <span aria-hidden="true" className="text-lg text-[#777]">
              ↗
            </span>
          </button>
        ))}
      </div>
    </dialog>
  )
}
