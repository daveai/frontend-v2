import { getBalancer } from '@/dependencies/balancer-sdk';
import { GasPriceService } from '@/services/gas-price/gas-price.service';
import { Pool } from '@/services/pool/types';
import { BalancerSDK, PoolWithMethods } from '@balancer-labs/sdk';
import { TransactionResponse } from '@ethersproject/abstract-provider';
import { Ref } from 'vue';
import {
  AmountsOut,
  ExitParams,
  ExitPoolHandler,
  QueryOutput,
} from './exit-pool.handler';
import { formatFixed, parseFixed } from '@ethersproject/bignumber';
import { isSameAddress } from '@/lib/utils';
import { TransactionBuilder } from '@/services/web3/transactions/transaction.builder';
import { flatTokenTree } from '@/composables/usePoolHelpers';
import { getAddress } from '@ethersproject/address';

/**
 * Handles cases where the pool is in a recovery mode.
 */
export class RecoveryExitHandler implements ExitPoolHandler {
  private lastExitRes?: ReturnType<PoolWithMethods['buildRecoveryExit']>;

  constructor(
    public readonly pool: Ref<Pool>,
    public readonly sdk: BalancerSDK,
    public readonly gasPriceService: GasPriceService
  ) {}

  async exit(params: ExitParams): Promise<TransactionResponse> {
    await this.queryExit(params);

    if (!this.lastExitRes) throw new Error('Failed to construct exit.');

    const txBuilder = new TransactionBuilder(params.signer);
    const { to, data } = this.lastExitRes;

    return txBuilder.raw.sendTransaction({ to, data });
  }

  async queryExit(params: ExitParams): Promise<QueryOutput> {
    const { signer, bptIn, slippageBsp } = params;
    const exiter = await signer.getAddress();
    const slippage = slippageBsp.toString();
    const sdkPool = await getBalancer().pools.find(this.pool.value.id);

    if (!sdkPool) throw new Error('Failed to find pool: ' + this.pool.value.id);

    const evmBptIn = parseFixed(bptIn, 18).toString();

    this.lastExitRes = await sdkPool.buildRecoveryExit(
      exiter,
      evmBptIn,
      slippage
    );

    if (!this.lastExitRes) throw new Error('Failed to construct exit.');

    const tokensOut = this.lastExitRes.attributes.exitPoolRequest.assets.filter(
      token => !isSameAddress(token, this.pool.value.address)
    );
    const expectedAmountsOut = this.lastExitRes.expectedAmountsOut;
    // Because this is an exit we need to pass amountsOut as the amountsIn and
    // bptIn as the minBptOut to this calcPriceImpact function.
    const evmPriceImpact = await sdkPool.calcPriceImpact(
      expectedAmountsOut,
      evmBptIn,
      false
    );
    const priceImpact = Number(formatFixed(evmPriceImpact, 18));

    const amountsOut = this.getAmountsOut(expectedAmountsOut, tokensOut);
    return {
      amountsOut,
      priceImpact,
    };
  }

  private getAmountsOut(
    expectedAmountsOut: string[],
    tokensOut: string[]
  ): AmountsOut {
    const amountsOut: AmountsOut = {};
    const allPoolTokens = flatTokenTree(this.pool.value);

    expectedAmountsOut.forEach((amount, i) => {
      const token = allPoolTokens.find(poolToken =>
        isSameAddress(poolToken.address, tokensOut[i])
      );

      if (token) {
        const realAddress = getAddress(token.address);
        const scaledAmount = formatFixed(
          amount,
          token.decimals ?? 18
        ).toString();
        amountsOut[realAddress] = scaledAmount;
      }
    });

    return amountsOut;
  }
}
