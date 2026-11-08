#pragma once
#include "switch.h"
#include <string>
#include <cstring>
#include <cstdio>
#include <functional>
#include <memory>
#include <vector>
namespace tsl {
namespace elm {
class Element {public:virtual ~Element()=default;virtual bool onClick(u64){return false;}};
class ListItem:public Element {public:std::string text,value;bool faint=false;std::function<bool(u64)>listener;
explicit ListItem(const std::string&t,const std::string&v=""):text(t),value(v){}
void setText(const std::string&t){text=t;}void setValue(const std::string&v,bool f=false){value=v;faint=f;}
void setClickListener(std::function<bool(u64)>f){listener=f;}
bool onClick(u64 keys)override{return listener?listener(keys):false;}};
class ToggleListItem:public ListItem {bool state;std::string on,off;public:
ToggleListItem(const std::string&t,bool s,const std::string&a="On",const std::string&b="Off"):ListItem(t),state(s),on(a),off(b){setState(s);}
void setState(bool s){state=s;setValue(s?on:off,!s);}bool getState(){return state;}};
class CategoryHeader:public ListItem {public:explicit CategoryHeader(const std::string&t):ListItem(t){}};
class List:public Element {public:std::vector<Element*>items;~List(){for(auto*p:items)delete p;}void addItem(Element*p){items.push_back(p);}};
class OverlayFrame:public Element {public:std::string title,version;Element*content=nullptr;OverlayFrame(const std::string&t,const std::string&v):title(t),version(v){}~OverlayFrame(){delete content;}void setContent(Element*p){content=p;}};
}
class Gui {public:virtual ~Gui()=default;virtual elm::Element*createUI()=0;virtual void update(){}};
class Overlay {public:virtual ~Overlay()=default;virtual void initServices(){}virtual void exitServices(){}virtual void onShow(){}virtual void onHide(){}virtual std::unique_ptr<Gui>loadInitialGui()=0;template<class G>std::unique_ptr<Gui>initially(){return std::make_unique<G>();}};
namespace hlp{template<class F>void doWithSmSession(F f){f();}}
template<class O>int loop(int,char**){return 0;}
}
