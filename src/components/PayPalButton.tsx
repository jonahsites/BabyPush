import React from "react";

interface PayPalButtonProps {
  onSuccess?: (details: any) => void;
  onError?: (err: any) => void;
}

export const PayPalButton: React.FC<PayPalButtonProps> = () => {
  return (
    <div className="w-full flex flex-col items-center gap-3">
      {/* Primary Safe Direct Checkout Link */}
      <div className="w-full bg-amber-50 border-3 border-black rounded-2xl p-4 sm:p-5 text-center space-y-3.5 shadow-[4px_4px_0px_0px_rgba(0,0,0,1)]">
        <div className="text-[11px] font-black uppercase text-amber-800 tracking-wider flex items-center justify-center gap-1.5">
          🛡️ PayPal Secure External Route (100% Reliable)
        </div>
        
        <p className="text-[10px] text-stone-800 font-bold leading-normal max-w-sm mx-auto">
          We process PayPal transactions in a dedicated secure tab to bypass browser sandboxing restrictions and guarantee absolute checkout safety.
        </p>
        
        <a 
          href="https://www.paypal.com/ncp/payment/47F5ZGZM4R5SC"
          target="_blank"
          rel="noopener noreferrer"
          className="w-full py-3 px-4 text-center bg-[#FFC439] hover:bg-[#F2B222] text-black font-black text-xs border-3 border-black rounded-xl hover:-translate-y-0.5 active:translate-y-0.5 transition-all flex items-center justify-center gap-2 uppercase shadow-[3px_3px_0px_0px_rgba(0,0,0,1)]"
        >
          💳 Pay Securely on PayPal &rarr;
        </a>
      </div>
    </div>
  );
};
