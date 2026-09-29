import { MICRO, MicroReject, MicroStateSchema, createProfile, equityUsd, freshState, observeState, readiness, sizeUsd, usdToLamports, type MicroProfile, type MicroState, type ReadinessReport, type Snapshot } from './policy';
import { book, recordFailure } from './ledger';
import { USDC_MINT } from '../core/types';
import type { SwapFill, SwapRequest } from '../execution/executor';

export interface SessionEngineDeps {
  address:string; profile?:MicroProfile; state?:MicroState;
  snapshot:()=>Promise<Snapshot>;
  persist:(state:MicroState)=>Promise<void>;
  execute:(request:SwapRequest,state:MicroState,stopped:()=>boolean)=>Promise<{fill:SwapFill;drag:bigint;solUsd:number}>;
  authorized:()=>boolean;
  cancelSignature:()=>void;
}

/** One promise owns the entire scan, wallet wait, settlement and durable write. */
export class SessionEngine {
  active=false;
  state?:MicroState;
  report:ReadinessReport|null=null;
  message:string|null=null;
  private work:Promise<void>|null=null;
  private generation=0;
  readonly profile:MicroProfile;
  constructor(private readonly d:SessionEngineDeps) {
    this.state=d.state;this.profile=d.state?.profile??d.profile??createProfile();
    if(this.state&&(this.state.wallet!==d.address||this.state.mode!=='LIVE'))throw new MicroReject('STATE_IDENTITY_MISMATCH');
  }
  arm():void {
    if(!this.d.authorized())throw new MicroReject('WALLET_SESSION_EXPIRED');
    if(this.work)throw new MicroReject('SCAN_IN_PROGRESS');
    if(this.state?.halted||this.state?.pending)throw new MicroReject('TRANSACTION_RECONCILIATION_REQUIRED');
    this.active=true;this.generation++;this.message='ARMED_AWAITING_GATES';
  }
  stop():void {this.active=false;this.generation++;this.d.cancelSignature();}
  async settled():Promise<void> {await this.work;}
  pulse():Promise<void> {
    if(this.work)return this.work;
    const work=this.scan().finally(()=>{if(this.work===work)this.work=null;});
    this.work=work;return work;
  }
  private async scan():Promise<void> {
    const generation=this.generation,wasArmed=this.active;
    const stopped=()=>!this.active||this.generation!==generation||!this.d.authorized();
    let fillReturned=false;
    try {
      const s=await this.d.snapshot();
      if(this.state){observeState(this.state,s);await this.d.persist(this.state);}
      this.report=readiness(s,this.profile,this.state);
      // Funding is assessed before the first baseline is persisted, never written as a loss.
      if(!this.state && equityUsd(s)<this.profile.initialBudgetUsd*.95)
        this.report.blockers.push('FUND_TO_PLANNED_BUDGET');
      if(!this.state && equityUsd(s)>this.profile.initialBudgetUsd*1.10)
        this.report.blockers.push('WALLET_EXCEEDS_MICRO_BUDGET');
      this.report.status=this.report.blockers.length?'BLOCKED':'QUOTE_REQUIRED';
      if(this.state?.halted){this.message=this.state.halted;this.stop();return;}
      if(this.report.blockers.length){this.message=this.report.blockers[0]!;return;}
      if(!wasArmed||stopped()){this.message='WALLET_CHECKED_START_REQUIRED';return;}
      if(!this.state) {
        this.state=freshState(this.d.address,'LIVE',s,this.profile);
        await this.d.persist(this.state);
      }
      if(stopped())return;
      const state=this.state;
      const side=state.lot?'SELL':'BUY';
      const amountRaw=state.lot?BigInt(state.lot.amount):usdToLamports(sizeUsd(state.equityUsd,this.profile.requestedTradeUsd,this.profile),s);
      state.pending={side,at:Date.now(),signature:null};
      await this.d.persist(state);
      if(stopped())throw new MicroReject('STOP_REQUESTED');
      const result=await this.d.execute({side,mint:USDC_MINT,amountRaw,slippageBps:MICRO.slippageBps},state,stopped);
      fillReturned=true;
      book(state,result.fill,{...s,solUsd:result.solUsd,at:Date.now()},result.drag);
      // Settlement must be accounted even if the user stopped after broadcast.
      observeState(state,{...s,native:BigInt(state.expectedNative),usdc:BigInt(state.expectedUsdc),at:Date.now()});
      state.equity.push({at:state.updatedAt,usd:state.equityUsd});state.equity=state.equity.slice(-1000);
      state.prices.push({at:s.at,solUsd:s.solUsd,usdcUsd:s.usdcUsd});state.prices=state.prices.slice(-1000);
      this.message=`${side}_CONFIRMED`;
      if(state.halted)this.stop();
    } catch(error) {
      this.report=null;
      if(this.state)recordFailure(this.state,error,fillReturned);
      // Never expose provider URLs, API keys, or raw RPC errors in the browser.
      this.message=error instanceof MicroReject?error.code:error instanceof Error&&error.cause instanceof MicroReject?error.cause.code:'SCAN_FAILED_CHECK_LOCAL_LOG';
      if(this.state?.halted)this.stop();
    } finally {
      if(!this.d.authorized())this.stop();
      if(this.state) {
        try {await this.d.persist(MicroStateSchema.parse(this.state));}
        catch {this.state.halted='STATE_WRITE_FAILED';this.message='STATE_WRITE_FAILED';this.stop();}
      }
    }
  }
}
