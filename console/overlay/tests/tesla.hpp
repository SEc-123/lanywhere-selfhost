#pragma once
#include "switch.h"
#include <algorithm>
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
class List : public Element {
public:
    std::vector<Element *> items;
    ~List() { for (auto *item : items) delete item; }
    void addItem(Element *item, u16 = 0, int index = -1) {
        if (index < 0 || static_cast<size_t>(index) >= items.size()) items.push_back(item);
        else items.insert(items.begin() + index, item);
    }
    void removeItem(Element *item) {
        auto found = std::find(items.begin(), items.end(), item);
        if (found != items.end()) { delete *found; items.erase(found); }
    }
};
class OverlayFrame:public Element {public:std::string title,version;Element*content=nullptr;OverlayFrame(const std::string&t,const std::string&v):title(t),version(v){}~OverlayFrame(){delete content;}void setContent(Element*p){content=p;}};
}
class Gui {
public:
    virtual ~Gui() = default;
    virtual elm::Element *createUI() = 0;
    virtual void update() {}
    virtual bool handleInput(u64, u64, const HidTouchState &, HidAnalogStickState, HidAnalogStickState) {
        return false;
    }
    elm::Element *getFocusedElement() { return nullptr; }
    void removeFocus() {}
    void restoreFocus() {}
};
inline std::unique_ptr<Gui> nextGui;
template<class G, class... Args> std::unique_ptr<Gui> &changeTo(Args&&... args) {
    nextGui = std::make_unique<G>(std::forward<Args>(args)...);
    return nextGui;
}
class Overlay {public:virtual ~Overlay()=default;virtual void initServices(){}virtual void exitServices(){}virtual void onShow(){}virtual void onHide(){}virtual std::unique_ptr<Gui>loadInitialGui()=0;template<class G>std::unique_ptr<Gui>initially(){return std::make_unique<G>();}};
namespace hlp {
template<class F>void doWithSmSession(F f) { f(); }
template<class F>void doWithSDCardHandle(F f) { f(); }
}
template<class O>int loop(int,char**){return 0;}
}
