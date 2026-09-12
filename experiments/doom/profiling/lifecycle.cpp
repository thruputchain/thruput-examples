#define main doom_runner_main
#include "../runner.cpp"
#undef main
using Clock=std::chrono::steady_clock;
static double ms(Clock::time_point a, Clock::time_point b) {
  return std::chrono::duration<double,std::milli>(b-a).count();
}
int main(int argc,char **argv) {
  require(argc == 2, "usage: lifecycle contract.rv32a");
  auto artifact=read_file(argv[1]);auto bytes=std::span<const uint8_t>(artifact);
  auto code=load_u32_le(artifact,52), initial=load_u32_le(artifact,56);
  auto make=[&](){
    auto p=ThreadedMachinePreInstantiation::create(bytes.subspan(128,code),bytes.subspan(128+code,initial),
      load_u32_le(artifact,60),load_u32_le(artifact,48),false);
    require(bool(p),"prepare failed");return std::move(*p);
  };
  Store base; base[key(0,0)]=Bytes(80);base[key(0,0)][0]=1;
  std::cout<<"mode,sample,prepare_ms,instantiate_ms,execute_ms,machine_destroy_ms,prepared_destroy_ms,total_ms\n";
  auto sample=[&](const char *mode,int i,auto &pre,Clock::time_point begin,Clock::time_point ready) {
    Clock::time_point instantiated,executed,destroyed;
    {
      ThreadedMachine vm(*pre,50000000);instantiated=Clock::now();vm.seed_method_id(4);
      DemoHost host(base,{});vm.run(host);executed=Clock::now();
      require(host.did_return && !host.failed && host.returned.size()==80,"status failed");
    }
    destroyed=Clock::now();
    if(std::string_view(mode)=="fresh")pre.reset();
    auto end=Clock::now();
    std::cout<<mode<<','<<i<<','<<ms(begin,ready)<<','<<ms(ready,instantiated)<<','
      <<ms(instantiated,executed)<<','<<ms(executed,destroyed)<<','<<ms(destroyed,end)<<','<<ms(begin,end)<<'\n';
  };
  {
    std::optional<ThreadedMachinePreInstantiation> pre(make());
    for(int i=0;i<51;++i){auto begin=Clock::now();sample("cached",i,pre,begin,begin);}
  }
  for(int i=0;i<51;++i){auto begin=Clock::now();std::optional<ThreadedMachinePreInstantiation> pre(make());auto ready=Clock::now();sample("fresh",i,pre,begin,ready);}
}
